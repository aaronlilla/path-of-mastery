# Third-party notices

Path of Mastery builds on the work below. Each licence is reproduced or pointed to here.

## Path of Building Community

The calculation engine in `crates/` and the game data in `engine-data/` are ported from, or derived from, Path of Building Community (https://github.com/PathOfBuildingCommunity/PathOfBuilding). Its licence:

    Copyright (c) 2016 David Gowor

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## NeverSink loot filter

The loot filters the app makes are based on the NeverSink filters (https://github.com/NeverSinkDev/NeverSink-Filter), MIT, copyright (c) 2026 NeverSink. The release the app ships and its licence are in `apps/desktop/resources/neversink/8.20.1d/`.

## exile-leveling

Quest and vendor gem offers, zones and routes come from exile-leveling by HeartofPhos (https://github.com/HeartofPhos/exile-leveling), MIT, copyright (c) 2025 HeartofPhos. Its licence is in `apps/desktop/resources/leveling/3.29/LICENSE-exile-leveling`.

## Game knowledge base

The knowledge base in `apps/desktop/resources/kb/` records its source, source URL, game patch and fetch time for every row. It draws on:

- Grinding Gear Games, Path of Exile game files from the patch CDN (patch.poecdn.com), read with pathofexile-dat (MIT, https://github.com/SnosMe/poe-dat-viewer) and dat-schema (MIT, https://github.com/poe-tool-dev/dat-schema).
- Grinding Gear Games, Path of Exile forum patch notes (https://www.pathofexile.com/forum/view-forum/patch-notes).
- exile-leveling, as above.
- Path of Building Community, as above: unique item text and boss tables, through the engine data.
- The Path of Exile Wiki (https://www.poewiki.net): divination card rewards, a snapshot used by the Build Filter. Wiki content is licensed CC BY-NC-SA 3.0 (https://creativecommons.org/licenses/by-nc-sa/3.0/), and each wiki row links its page.
- poe-tool-dev/latest-patch-version (MIT), for the latest patch version pointer.

Path of Exile and its content are the property of Grinding Gear Games. This project is not affiliated with or endorsed by Grinding Gear Games.
