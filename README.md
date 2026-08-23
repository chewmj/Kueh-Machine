# 家常菜 · Taste of Home

By Mei Jun

## Concept

A digital scrapbook for documenting my mum's home-cooked recipes the way she
actually teaches them: in her own vague, intuitive words ("a handful," "$2
worth of ginger"), paired side by side with the tangible measurements I
translate them into as I learn and recreate each dish. A built-in glossary
turns her common phrases into real measurements over time, useful for anyone
doing the quiet work of turning 家传菜 (family-handed-down cooking) into
something that survives them. Part of kuehmachine.com: kueh, the handmade
and culturally-loaded, run through a machine that turns intuition into
something repeatable.

## Look and feel

Warm scrapbook aesthetic — cream paper background, recipe cards styled like
pasted-in pages with a washi-tape accent and a slight rotation. Body text in
Noto Serif SC (handles Chinese and English gracefully), accents in Caveat, a
handwritten-feel font, for the personal, diary-like touches. Palette: paper
cream, deep ink brown, and a chili-red accent.

## The recipes in here

Three dishes documented with mum so far, built into the project rather than
living only in one browser:

- **Hainanese Yi Bua Kueh** 椰糖蒸糕 — coconut palm sugar steamed cake
- **Orh Kueh / Yam Cake** 芋头糕 — the one she makes for family gatherings
- **Tang Yuan / Glutinous Rice Balls** 汤圆

They load automatically the first time the site is opened in any browser, in
the order set here. Their photos are real files in `./media/`, referenced by
relative path. Anything added, edited, reordered or deleted in the browser
after that lives in IndexedDB and takes precedence over the built-in copies.

### Updating what ships in the folder

Recipes written in the browser live only in that browser. To fold new ones,
edits or a new running order into the project itself:

1. Click **Back up** in the site footer. A `taste-of-home-backup-<date>.json`
   lands in Downloads.
2. Run `python3 tools/build-seed.py ~/Downloads/taste-of-home-backup-<date>.json`

That rewrites `media/` and `recipes-seed.js` from the backup, resizing photos
to 1600px JPEGs so the folder stays small enough to zip. Check the result in a
private window, which has no saved data and so shows exactly what someone
opening the site for the first time will see.

## Features

- [x] Basic page scaffold and scrapbook visual style
- [x] Recipe card entry form (dish name, story, ingredients in her words +
      translated, steps, photos)
- [x] Photo/video attachment per recipe, saved in the browser
- [x] Growing, searchable glossary of vague measurement phrases → real
      measurements
- [x] Voice-to-text capture (Mandarin + English/Singlish) for recording her
      spoken instructions while cooking
- [x] Reorder recipes to control the sequence they're told in
- [x] Share a recipe out (native share sheet, or copied to clipboard as a
      fallback)
- [x] Add photos/videos to a recipe's gallery without overwriting what's
      already there — remove individual items instead
- [x] Back up everything (recipes, photos/videos, glossary) to one file, and
      restore it in any browser — since content otherwise lives only in the
      browser it was created in
- [ ] Multiple "attempts" per dish, to track the learning journey over time
