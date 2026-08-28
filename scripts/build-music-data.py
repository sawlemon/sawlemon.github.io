#!/usr/bin/env python3
"""Parse Apple Music Replay API summaries (/tmp/replay) into src/data/music.json.

Input files: year-YYYY.json and month-YYYY-MM.json fetched by scripts/refresh-music/.
"""
import json
import glob
import os
import re
from datetime import date

REPLAY_DIR = os.environ.get("REPLAY_DIR", "/tmp/replay")
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "data", "music.json")

MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def artwork_url(template, size=200):
    if not template:
        return None
    return template.replace("{w}x{h}", f"{size}x{size}").replace("{c}", "bb")


def song_attrs(res, summary):
    rel = (summary.get("relationships", {}).get("song", {}) or {}).get("data", [])
    if not rel:
        return None
    song = res.get("songs", {}).get(rel[0]["id"])
    if not song:
        return None
    a = song.get("attributes", {})
    return {
        "title": a.get("name"),
        "artist": a.get("artistName"),
        "album": a.get("albumName"),
        "artwork": artwork_url((a.get("artwork") or {}).get("url")),
    }


def artist_attrs(res, summary):
    rel = (summary.get("relationships", {}).get("artist", {}) or {}).get("data", [])
    if not rel:
        return None
    artist = res.get("artists", {}).get(rel[0]["id"])
    if not artist:
        return None
    return artist.get("attributes", {}).get("name")


def album_attrs(res, summary):
    rel = (summary.get("relationships", {}).get("album", {}) or {}).get("data", [])
    if not rel:
        return None
    album = res.get("albums", {}).get(rel[0]["id"])
    if not album:
        return None
    a = album.get("attributes", {})
    return {
        "name": a.get("name"),
        "artist": a.get("artistName"),
        "artwork": artwork_url((a.get("artwork") or {}).get("url")),
    }


def build():
    years = {}
    for path in sorted(glob.glob(os.path.join(REPLAY_DIR, "year-*.json"))):
        m = re.search(r"year-(\d{4})\.json$", path)
        if not m:
            continue
        year = m.group(1)
        yd = json.load(open(path))
        if not yd.get("data"):
            continue  # 404 body: no replay data for this year
        res = yd["resources"]

        songs = []
        for s in res.get("song-period-summaries", {}).values():
            meta = song_attrs(res, s)
            if not meta:
                continue
            songs.append({**meta, "plays": s["attributes"]["playCount"]})
        songs.sort(key=lambda x: -x["plays"])

        artists = []
        for s in res.get("artist-period-summaries", {}).values():
            name = artist_attrs(res, s)
            if not name:
                continue
            a = s["attributes"]
            artists.append({"name": name, "minutes": a.get("listenTimeInMinutes", 0), "plays": a.get("playCount", 0)})
        artists.sort(key=lambda x: -x["minutes"])

        albums = []
        for s in res.get("album-period-summaries", {}).values():
            meta = album_attrs(res, s)
            if not meta:
                continue
            a = s["attributes"]
            albums.append({**meta, "minutes": a.get("listenTimeInMinutes", 0), "plays": a.get("playCount", 0)})
        albums.sort(key=lambda x: -x["minutes"])

        months = []
        for path in sorted(glob.glob(os.path.join(REPLAY_DIR, f"month-{year}-*.json"))):
            md = json.load(open(path))
            if not md.get("data"):
                continue  # 404 body: no summary for this month
            summary = md["data"][0]
            res_summaries = md.get("resources", {}).get("music-summaries", {})
            attrs = (res_summaries.get(summary["id"]) or summary).get("attributes", {})
            month_num = attrs.get("month") or int(path.rsplit("-", 1)[1].split(".")[0])
            mres = md.get("resources", {})
            top_artists = []
            for s in mres.get("artist-period-summaries", {}).values():
                name = artist_attrs(mres, s)
                if not name:
                    continue
                top_artists.append({"name": name, "minutes": s["attributes"].get("listenTimeInMinutes", 0)})
            top_artists.sort(key=lambda x: -x["minutes"])
            months.append({
                "month": month_num,
                "label": MONTH_LABELS[month_num - 1],
                "minutes": attrs.get("listenTimeInMinutes", 0),
                "artists": top_artists[:5],
            })
        months.sort(key=lambda m: m["month"])

        playlists = list(res.get("playlists", {}).values())
        replay_playlists = [p for p in playlists if str(p.get("id", "")).startswith("pl.rp-")]
        pick = next((p for p in replay_playlists if p.get("attributes", {}).get("name") == f"Replay {year}"),
                    replay_playlists[0] if replay_playlists else (playlists[0] if playlists else None))
        playlist = None
        if pick:
            a = pick.get("attributes", {})
            playlist = {"name": a.get("name"), "url": a.get("url"), "id": pick.get("id")}

        years[year] = {
            "minutes": sum(m["minutes"] for m in months),
            "months": months,
            "topSongs": songs,
            "topArtists": artists,
            "topAlbums": albums,
            "playlist": playlist,
        }

    if not years:
        raise SystemExit(f"no usable year-*.json files found in {REPLAY_DIR} — run scripts/refresh-music/ first")
    out = {"generated": date.today().isoformat(), "years": years}
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    print("wrote", OUT)
    for y, d in years.items():
        print(y, "minutes:", d["minutes"], "songs:", len(d["topSongs"]), "artists:", len(d["topArtists"]),
              "months:", [(m["label"], m["minutes"]) for m in d["months"]])


if __name__ == "__main__":
    build()
