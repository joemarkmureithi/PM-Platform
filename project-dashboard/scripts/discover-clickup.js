#!/usr/bin/env node
// Run with CLICKUP_API_TOKEN set (in your shell env or a .env loaded by your
// shell) to print your workspace tree: Team -> Space -> Folder -> List,
// with the IDs you need for CLICKUP_LIST_ID in .env.
//
//   CLICKUP_API_TOKEN=pk_xxx node scripts/discover-clickup.js

const { client } = require("../netlify/functions/lib/clickupClient");

async function main() {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) {
    console.error("Set CLICKUP_API_TOKEN first, e.g.\n  CLICKUP_API_TOKEN=pk_xxx node scripts/discover-clickup.js");
    process.exit(1);
  }
  const cu = client(token);

  const { teams } = await cu.getTeams();
  for (const team of teams) {
    console.log(`\nTeam (workspace): ${team.name}  [id: ${team.id}]`);
    const { spaces } = await cu.getSpaces(team.id);
    for (const space of spaces) {
      console.log(`  Space: ${space.name}  [id: ${space.id}]`);

      const { folders } = await cu.getFolders(space.id);
      for (const folder of folders) {
        console.log(`    Folder: ${folder.name}  [id: ${folder.id}]`);
        for (const list of folder.lists || []) {
          console.log(`      List: ${list.name}  [id: ${list.id}]  <-- use as CLICKUP_LIST_ID`);
        }
      }

      const { lists: folderlessLists } = await cu.getFolderlessLists(space.id);
      for (const list of folderlessLists || []) {
        console.log(`    List (folderless): ${list.name}  [id: ${list.id}]  <-- use as CLICKUP_LIST_ID`);
      }
    }
  }
  console.log("\nCopy the ID of the List that holds your portfolio's project tasks into .env as CLICKUP_LIST_ID.");
}

main().catch((err) => {
  console.error("Discovery failed:", err.message);
  process.exit(1);
});
