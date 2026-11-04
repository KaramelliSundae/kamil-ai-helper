#!/usr/bin/env bash
# Renders the app icons from the SVGs next to this script. Needs ImageMagick with librsvg (for example on
# Linux). Writes into ../ (mobile/assets).
set -euo pipefail
cd "$(dirname "$0")"
out=..

magick -background none foreground.svg "$out/adaptive-icon.png"
magick background.svg "$out/adaptive-background.png"
# Android 13+ themed icons use only the alpha channel, so the colours do not matter here.
magick "$out/adaptive-icon.png" -fill white -colorize 100 "$out/monochrome-icon.png"
magick "$out/adaptive-background.png" "$out/adaptive-icon.png" -composite "$out/icon.png"

# What a round launcher mask shows, for checking by eye. Not used by the build.
magick "$out/icon.png" \( +clone -alpha transparent -fill white -draw "circle 512,512 512,171" \) \
  -compose DstIn -composite preview-round.png
