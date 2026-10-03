#!/usr/bin/env python3
"""Turn a Taste of Home backup file into the project's built-in content.

Usage:  python3 tools/build-seed.py <backup.json> [--order "Orh,Fried,Hainanese,Tang"]

--order takes a comma-separated list of dish-name beginnings and puts the
recipes in that sequence. Without it, the order saved in the backup is kept.

Reads a backup exported with the site's "Back up" button and rewrites
./media/ and ./recipes-seed.js so the recipes, their order, their photos,
videos, voice recordings and the glossary all ship inside the project folder.
Photos are resized to 1600px JPEGs so the folder stays small enough to zip;
video and audio are copied through untouched, so keep an eye on their size.
"""

import base64
import datetime
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEDIA_DIR = os.path.join(ROOT, 'media')
SEED_FILE = os.path.join(ROOT, 'recipes-seed.js')
INDEX_FILE = os.path.join(ROOT, 'index.html')

IMAGE_EXT = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/heic': 'heic', 'image/webp': 'webp'}
VIDEO_EXT = {'video/quicktime': 'mov', 'video/mp4': 'mp4', 'video/webm': 'webm'}
AUDIO_EXT = {
    'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg',
}


def make_poster(video_path, out_name):
    """Grab a still from a video with Quick Look, so cards have something to show."""
    tmp_dir = os.path.join(MEDIA_DIR, '.posters')
    os.makedirs(tmp_dir, exist_ok=True)
    try:
        subprocess.run(['qlmanage', '-t', '-s', '1200', '-o', tmp_dir, video_path],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shot = os.path.join(tmp_dir, os.path.basename(video_path) + '.png')
        if not os.path.exists(shot):
            return None
        subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '82',
                        '-Z', '960', shot, '--out', os.path.join(MEDIA_DIR, out_name)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return out_name
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def to_h264(video_path):
    """iPhone video is usually HEVC, which Firefox and many Chrome installs
    can't play. Re-encode to H.264 MP4 with macOS's own converter."""
    out_path = os.path.splitext(video_path)[0] + '.mp4'
    tmp_path = out_path + '.tmp.mp4'
    try:
        subprocess.run(['avconvert', '--source', video_path, '--preset', 'Preset1280x720',
                        '--output', tmp_path, '--replace'],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print(f'  ! Could not convert {os.path.basename(video_path)}; it may not play in every browser')
        return video_path
    os.remove(video_path)
    os.rename(tmp_path, out_path)
    return out_path


def read_media(item):
    """The file's bytes and type: from the backup, or, for built-in media the
    browser hadn't copied in yet, from the project's current media folder."""
    if item.get('dataUrl'):
        header, encoded = item['dataUrl'].split(',', 1)
        return base64.b64decode(encoded), header[5:].split(';')[0]
    src = item.get('src')
    if src and os.path.exists(os.path.join(ROOT, src)):
        with open(os.path.join(ROOT, src), 'rb') as f:
            data = f.read()
        ext = os.path.splitext(src)[1][1:].lower()
        every = {**IMAGE_EXT, **VIDEO_EXT, **AUDIO_EXT}
        mime = next((m for m, e in every.items() if e == ext), 'image/jpeg')
        return data, mime
    return None, None


def bump_asset_version():
    """Change the ?v= tag on index.html's own files, so browsers that cached
    the old ones fetch the new recipes instead of quietly reusing them."""
    with open(INDEX_FILE) as f:
        html = f.read()
    stamp = datetime.datetime.now().strftime('%Y%m%d%H%M')
    html = re.sub(r'(\./(?:style\.css|script\.js|recipes-seed\.js))(\?v=[^"]*)?"', rf'\1?v={stamp}"', html)
    with open(INDEX_FILE, 'w') as f:
        f.write(html)


def slug(text):
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')[:24].strip('-')


def main():
    args = sys.argv[1:]
    order_names = None
    if '--order' in args:
        at = args.index('--order')
        order_names = [n.strip() for n in args[at + 1].split(',') if n.strip()]
        del args[at:at + 2]

    if len(args) != 1:
        sys.exit('Usage: python3 tools/build-seed.py <backup.json> [--order "A,B,C"]')

    backup_path = os.path.expanduser(args[0])
    with open(backup_path) as f:
        data = json.load(f)

    if data.get('app') != 'tasteOfHome':
        sys.exit('That file does not look like a Taste of Home backup.')

    recipes = sorted(data['recipes'], key=lambda r: r.get('order', 0))

    # Read everything before clearing the media folder, since built-in files
    # missing from the backup are taken from it.
    for recipe in recipes:
        for item in recipe.get('media', []):
            item['_bytes'], item['_mime'] = read_media(item)
            if item['_bytes'] is None:
                print(f"  ! Skipping \"{item.get('name')}\" in {recipe['nameEn']}: no file in the backup")

    # Start from a clean media folder so deleted photos don't linger in the zip.
    if os.path.isdir(MEDIA_DIR):
        shutil.rmtree(MEDIA_DIR)
    os.makedirs(MEDIA_DIR)

    if order_names:
        chosen = []
        for name in order_names:
            match = next((r for r in recipes if r['nameEn'].lower().startswith(name.lower())), None)
            if match is None:
                sys.exit(f'No recipe starts with "{name}".')
            chosen.append(match)
        # Anything not named keeps its place at the end.
        recipes = chosen + [r for r in recipes if r not in chosen]
    out = []

    for position, recipe in enumerate(recipes):
        name = slug(recipe['nameEn'])
        media_out = []

        present = [m for m in recipe.get('media', []) if m['_bytes'] is not None]
        for index, item in enumerate(present, 1):
            poster = None
            mime = item['_mime']
            raw_ext = IMAGE_EXT.get(mime) or VIDEO_EXT.get(mime) or AUDIO_EXT.get(mime) or 'bin'
            raw_path = os.path.join(MEDIA_DIR, f'raw-{name}-{index}.{raw_ext}')
            with open(raw_path, 'wb') as f:
                f.write(item['_bytes'])

            # Only photos get resized; video and audio are copied through as they are.
            if mime in VIDEO_EXT or mime in AUDIO_EXT:
                final_name = f'{name}-{index}.{raw_ext}'
                final_path = os.path.join(MEDIA_DIR, final_name)
                os.rename(raw_path, final_path)
                if mime in VIDEO_EXT:
                    final_path = to_h264(final_path)
                    final_name = os.path.basename(final_path)
                    poster = make_poster(final_path, f'{name}-{index}-poster.jpg')
            else:
                final_name = f'{name}-{index}.jpg'
                subprocess.run(
                    ['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80',
                     '-Z', '1600', raw_path, '--out', os.path.join(MEDIA_DIR, final_name)],
                    check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                os.remove(raw_path)

            media_out.append({
                **({'poster': f'./media/{poster}'} if poster else {}),
                'id': f'{name}-{index}',
                'type': item.get('type', 'image'),
                # What it was called in the browser, not what the file is called.
                'name': item.get('name') or final_name,
                'description': item.get('description', ''),
                'src': f'./media/{final_name}',
            })

        out.append({
            'id': recipe['id'],
            'nameEn': recipe['nameEn'],
            'nameCn': recipe.get('nameCn', ''),
            'story': recipe.get('story', ''),
            'ingredients': recipe.get('ingredients', []),
            'steps': recipe.get('steps', []),
            'order': position,
            'createdAt': recipe.get('createdAt'),
            'media': media_out,
        })

    glossary = [{'term': e['term'], 'meaning': e['meaning']} for e in data.get('glossary', [])]

    header = """/* ---------- Built-in content ----------
   Generated by tools/build-seed.py from a backup file. Don't hand-edit:
   change things in the browser, hit "Back up", and run the script again.

   These are the recipes and glossary the site loads on first open in any
   browser, in this exact order. Photos are real files in ./media/, linked by
   relative path. Anything added, edited, reordered or deleted in a browser
   after that lives in IndexedDB and takes precedence over what's here. */

const SEED_RECIPES = """

    body = json.dumps(out, ensure_ascii=False, indent=2)
    gloss = json.dumps(glossary, ensure_ascii=False, indent=2)

    with open(SEED_FILE, 'w') as f:
        f.write(header + body + ';\n\nconst SEED_GLOSSARY = ' + gloss + ';\n')

    bump_asset_version()

    total_media = sum(len(r['media']) for r in out)
    size_mb = sum(
        os.path.getsize(os.path.join(MEDIA_DIR, n)) for n in os.listdir(MEDIA_DIR)
    ) / 1024 / 1024

    print(f'{len(out)} recipes, {len(glossary)} glossary entries, {total_media} media files ({size_mb:.1f} MB)')
    for r in out:
        print(f"  {r['order'] + 1}. {r['nameEn']} — {len(r['ingredients'])} ingredients, "
              f"{len(r['steps'])} steps, {len(r['media'])} photos")


if __name__ == '__main__':
    main()
