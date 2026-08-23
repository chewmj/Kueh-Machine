# Shared database

> **Setup note:** Save this file as `DATABASE.md` in your project folder, next to your existing `CLAUDE.md`. Claude Code reads it automatically from there.

kuehmachine.com already has one shared Supabase project wired in through `shared/account-widget.js`, the script that gives every project its sign-in badge. If your project has a score, an unlock, a habit streak, or any piece of progress that currently resets when the page reloads or gets opened on another device, it can follow the signed-in account instead.

Six projects already do this, in different amounts. Ruth's and Liwei's games came first and have full backends: accounts, cumulative leaderboards, Ruth's own friends system. Ken's kueh collection, Amy's kueh reveals, Natalia's habit tracker, and Sophia's cat map are newer and smaller, built specifically to show how little this takes. Claude Code — read `AUTH.md` at the repo root first. It has copy-paste SQL templates and explains the account system in full. `machines/ken/js/app.js` plus `supabase/migrations/0002_ken_collection.sql` is the smallest real example if you want to see the whole thing end to end.

Leonard runs this project and owns the actual Supabase dashboard. Nobody else has login access to it, no exceptions. That's the one constant across everything below.

## First: do you have the full kuehmachine.com repo, or just your own project folder?

**If you're Liwei:** you already have the whole repo cloned and push to it directly. Everything below applies to you exactly as written: write your migration file, commit it, push it, and tell Leonard what SQL to run.

**If you're anyone else:** you're working in your own isolated project folder, the same one you'll eventually zip up and hand to Leonard. You don't have `AUTH.md`, `supabase/migrations/`, or the account widget's source sitting locally, and that's fine. See "Working from your own project folder" below before step 1. It changes two small things, not the overall approach.

## What to actually do

1. Check that `shared/account-widget.js` loads before this project's own scripts, not after. This was the most common mistake across all four newest examples: a project's own script reads `window.KuehAccount` at its top level, so if the account widget's `<script>` tag comes later in the page, that read happens before the object exists.

2. Work out which shape the data needs:
   - **Private** — a save only this player should see (a score, an unlocked collection, saved progress). One row per user, a single `jsonb` column, RLS locked to `auth.uid()`. Copy `ken_collection`'s table.
   - **Public** — a leaderboard, a shared map, anything other players should see or add to. One row per item, public read. Copy `ruth_scores` or `liwei_scores` if rows are append-only, or `sophia_cats` if other players need to edit an existing row.

3. Write the new table as its own file under `supabase/migrations/`, numbered one past whatever's already there. Don't edit the existing migration files. (If you're not working from the full repo, see below: this step changes slightly.)

4. Wire the client so it reads from the table on load when signed in, and writes to it on every local save. Keep whatever local storage the project already uses as the fallback for signed-out players. Nothing on the site should require an account to work.

5. Leonard has to run the SQL himself, whichever path you're on. Give him the exact block to paste into the Supabase SQL editor, the same way it's already been done for Ken, Amy, Natalia, and Sophia.

## Working from your own project folder

Most contributors don't have the full repo locally, just their own project. Two things change, nothing else:

- **Point the account widget at the live site while you test.** `/shared/account-widget.js` is a root-relative path. It only resolves once your project is actually part of the deployed site. For local testing, use the full address instead: `https://kuehmachine.com/shared/account-widget.js`. It's the same script and the same shared Supabase project, and works fine from a project running entirely on its own. Switch it back to `/shared/account-widget.js` before you zip your project up for Leonard, the same way every other path in your project has to be relative before handoff.

- **You can build and test the whole thing before the table exists.** Write your migration as a plain `database.sql` file inside your own project folder instead of under `supabase/migrations/`. You don't have that folder locally, so this is the version of "write the new table as its own file" that applies to you. Your client code can be written and tested in full right away: every real example on this site already catches a failed Supabase call and falls back without crashing, so querying a table that doesn't exist yet just logs a warning and your local-storage fallback keeps working exactly as it does today. You're not blocked waiting on Leonard at any point. When you hand your project off, `database.sql` goes in the zip along with everything else, and Leonard adds it to the real `supabase/migrations/` folder and runs it during integration.

## What not to do

- Don't wire your actual project to a separate Supabase project or a different URL or key. It needs to end up on the one shared project, through the one `shared/account-widget.js`. Spinning up your own free Supabase project on the side to learn RLS or try something out is completely fine. Just don't ship that as what your submission depends on.
- Don't require sign-in for the core feature to work. Every project on this site needs to work fully for someone who never makes an account.
- Don't skip row level security, and don't guess at a policy that isn't actually right for who should read or write that table. A table with RLS off is a real security hole, not a shortcut.
