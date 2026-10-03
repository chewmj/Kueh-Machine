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

Four dishes documented with mum so far, built into the project rather than
living only in one browser:

- **Orh Kueh / Yam Cake** 芋头糕 — the one she makes for family gatherings
- **Fried Honeycomb** 炸蜂窝 — Chinese New Year goodies for relatives and friends
- **Hainanese Yi Bua Kueh** 薏粑 — coconut palm sugar steamed cake
- **Tang Yuan / Glutinous Rice Balls** 汤圆

They load automatically in any browser, in the order set here. Their photos,
video and voice recording are real files in `./media/`, referenced by relative
path, and show straight from there while a copy is pulled into the browser in
the background.

Each browser checks `recipes-seed.js` on every visit. A recipe it hasn't seen
yet is added, and a built-in recipe nobody has edited in that browser is
brought up to date. Anything edited or deleted in a browser stays that way
there, and takes precedence over the built-in copy.

If a browser blocks storage (some private windows, Safari opening the file
straight off disk), the recipes still show; changes just don't outlast the
tab.

### Updating what ships in the folder

Recipes written in the browser live only in that browser. To fold new ones,
edits or a new running order into the project itself:

1. Click **Back up** in the site footer. A `taste-of-home-backup-<date>.json`
   lands in Downloads.
2. Run `python3 tools/build-seed.py ~/Downloads/taste-of-home-backup-<date>.json`

That rewrites `media/` and `recipes-seed.js` from the backup, resizing photos
to 1600px JPEGs so the folder stays small enough to zip, and converting video
to H.264 MP4 (iPhone video is usually HEVC, which Firefox and many Chrome
installs can't play). It also bumps the `?v=` tag on the files `index.html`
loads, so browsers that cached the old ones fetch the new recipes. Check the result in a
private window, which has no saved data and so shows exactly what someone
opening the site for the first time will see.

### Running it locally

Double-click **Start Kueh Machine.command**. It serves the folder with
`tools/serve.py`, which tells the browser to check for newer files on every
load. Python's plain `http.server` doesn't, and browsers then keep showing an
old version for days.

## Features

- [x] Basic page scaffold and scrapbook visual style
- [x] Recipe card entry form (dish name, story, ingredients in her words +
      translated, steps, photos)
- [x] Photo, video and voice recording attachments per recipe, saved in the
      browser, each nameable with an optional note and draggable into the
      order you want; photos and video open in a
      gallery pop-up, photos again for a full-window view, and
      recordings play inside the recipe pop-up
- [x] Growing, searchable glossary of vague measurement phrases → real
      measurements
- [x] Voice-to-text capture (Mandarin + English/Singlish) for recording her
      spoken instructions while cooking
- [x] Drag recipes, and the ingredients, steps and media within them, into the
      sequence they're told in
- [x] Share a recipe out (native share sheet, or copied to clipboard as a
      fallback), or save it as a PDF laid out for paper
- [x] Add photos/videos to a recipe's gallery without overwriting what's
      already there — remove individual items instead
- [x] Back up everything (recipes, photos/videos, glossary) to one file, and
      restore it in any browser — since content otherwise lives only in the
      browser it was created in
- [ ] Multiple "attempts" per dish, to track the learning journey over time
