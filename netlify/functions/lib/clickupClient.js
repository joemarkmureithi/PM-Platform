// Thin wrapper around the ClickUp API v2. Uses the global fetch available in
// Node 18+ (Netlify Functions runtime) — no extra HTTP dependency needed.

const BASE = "https://api.clickup.com/api/v2";

function client(token) {
  if (!token) {
    throw new Error("Missing ClickUp API token");
  }

  async function request(path, params = {}, init = {}) {
    const url = new URL(BASE + path);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ClickUp API ${res.status} ${res.statusText} on ${path}: ${body}`);
    }
    return res.json();
  }

  return {
    getTeams: () => request("/team"),
    getSpaces: (teamId) => request(`/team/${teamId}/space`, { archived: false }),
    getFolders: (spaceId) => request(`/space/${spaceId}/folder`, { archived: false }),
    getFolderlessLists: (spaceId) => request(`/space/${spaceId}/list`, { archived: false }),
    getListsInFolder: (folderId) => request(`/folder/${folderId}/list`, { archived: false }),

    // Pulls every TOP-LEVEL task in a list (one project = one task),
    // including custom fields, with pagination. Deliberately does NOT
    // request subtasks=true -- each project's activities/checklist items
    // live as subtasks underneath it, and pulling them in here would flood
    // the portfolio view with hundreds of non-project rows. Belt-and-braces:
    // also filters out anything with a parent, in case a list's own view
    // settings surface subtasks regardless of the query param.
    async getListTasks(listId, { includeClosed = true } = {}) {
      let page = 0;
      let all = [];
      while (true) {
        const data = await request(`/list/${listId}/task`, {
          include_closed: includeClosed,
          subtasks: false,
          page,
        });
        all = all.concat(data.tasks || []);
        if (data.last_page !== false && (data.tasks || []).length === 0) break;
        if (data.last_page) break;
        page += 1;
        if (page > 20) break; // safety valve
      }
      return all.filter((t) => !t.parent);
    },

    // Every task in the list INCLUDING subtasks (all levels), with the same
    // full shape (custom_fields, assignees, etc.) as getListTasks above --
    // used to roll subtask-level ownership up to each project's effective
    // assignee list. Deliberately NOT built on top of getSubtasks()/Get Task
    // (`include_subtasks=true`): a live screenshot showed subtasks with
    // clear owners in ClickUp (2026-09-11) that the include_subtasks-based
    // rollup was silently missing, which points at that endpoint returning a
    // lighter subtask shape (possibly without full custom_fields) rather
    // than the same rich shape as a normal task list fetch. This reuses the
    // Get Tasks (list) endpoint instead -- the same, already-verified-live
    // code path getListTasks uses -- just with `subtasks: true` and without
    // filtering out tasks that have a parent.
    async getListTasksWithSubtasks(listId) {
      let page = 0;
      let all = [];
      while (true) {
        const data = await request(`/list/${listId}/task`, {
          include_closed: true,
          subtasks: true,
          page,
        });
        all = all.concat(data.tasks || []);
        if (data.last_page !== false && (data.tasks || []).length === 0) break;
        if (data.last_page) break;
        page += 1;
        if (page > 40) break; // safety valve -- higher than getListTasks' since this includes every subtask too
      }
      return all;
    },

    // Creates a task (used by the idea/new-project intake form). Callers are
    // responsible for shaping `payload` -- typically { name, description,
    // due_date }. We deliberately do NOT try to guess custom-field IDs on the
    // target list here, since that varies list-to-list and can't be verified
    // without live access; product/category/date context gets folded into
    // the description instead so nothing submitted is ever lost.
    createTask(listId, payload) {
      return request(`/list/${listId}/task`, {}, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },

    // Fetches one task WITH its subtasks (used only for the AI narrative
    // generator, which needs the granular activity detail we deliberately
    // exclude from the main portfolio list -- see getListTasks above).
    getTaskDetail(taskId) {
      return request(`/task/${taskId}`, { include_subtasks: true });
    },

    // Every task's subtasks, without the full parent task detail -- used by
    // the Weekly Activity view, which just needs "what's moving" per active
    // project, not the whole narrative-generation payload getTaskDetail pulls.
    async getSubtasks(taskId) {
      const detail = await request(`/task/${taskId}`, { include_subtasks: true });
      return (detail.subtasks || []).filter((t) => t.parent === taskId);
    },

    // The list's custom field definitions -- field ids and, for dropdowns,
    // each option's id/orderindex/name. Needed to WRITE a custom field value
    // (unlike reading, where the field comes back already attached to each
    // task, writing requires the field's id, which only this endpoint has).
    async getListFields(listId) {
      const data = await request(`/list/${listId}/field`);
      return data.fields || [];
    },

    // Members assignable to tasks on this list -- populates the owner picker
    // in the Decisions & Gaps inline editor.
    async getListMembers(listId) {
      const data = await request(`/list/${listId}/member`);
      return data.members || [];
    },

    // Native-field update (currently: due_date, assignees). ClickUp's Update
    // Task endpoint takes assignees as { add: [...], rem: [...] } rather than
    // a plain replacement array.
    updateTask(taskId, body) {
      return request(`/task/${taskId}`, {}, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    },

    // Custom-field write. For a drop_down field, `value` must be the
    // option's orderindex (confirmed against live data 2026-08-21 -- same
    // convention getCustomField() in transform.js already reads back), not
    // its id. For a plain text field, `value` is just the string.
    setCustomFieldValue(taskId, fieldId, value) {
      return request(`/task/${taskId}/field/${fieldId}`, {}, {
        method: "POST",
        body: JSON.stringify({ value }),
      });
    },
  };
}

module.exports = { client };
