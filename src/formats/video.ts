// Cutscene video banks (.vdu): catalog and header facts only.
//
// Pictures are not decoded here. The retail videos are WMV2 inside ASF, which
// browsers can't play, so `npm run bake` (tools/bake.ts) converts every video
// once with ffmpeg into game/converted/ and the app plays those files with a
// plain <video> element (src/app/cutscene.ts). This module provides what the
// engine and the bake still need from the original files: the list of videos,
// their "pkg:id" keys, groups and durations, the embedded ASF stream, and the
// soundtrack pairing.
//
// A .vdu is an SRSC container with two entries per video (same id):
//   type 0x42 group 3  "Surreal" header, u32 fields:
//     +0 version (2), +4 fps, +8 duration ms (ASF send duration: up to ~1.5 s
//     longer than the picture for short clips), +12 width, +16 height,
//     +20 bits per pixel (24), +24 n, then n u32 read-ahead offsets and two
//     copies of the stream size.
//   type 0x43 group 3  a Windows Media (ASF) file, video stream only, whose
//     Simple Index object was also copied in front of the Header object:
//     [Index][Header][Data][Index]. Standard demuxers expect the Header first,
//     so asfStream() strips the leading copy.
// The directory `extra` of both entries is an asset-group number shared with
// the video's soundtrack in the sibling .sdu (see findSoundtrack).
//
// Retail data: 35 videos, all 512x512 WMV2 at a nominal 30 fps with irregular
// timestamps (dropped frames, one-second holds on stills).

import type { SrscEntry, SrscFile } from './srsc';
import { SoundCategory, type SoundInfo } from './sound';

export const VIDEO_HEADER_TYPE = 0x42;
export const VIDEO_DATA_TYPE = 0x43;

export interface VideoInfo {
  /** "pkg:id": the cross-file reference form used by the engine. */
  key: string;
  pkg: number;
  id: number;
  /** Asset-group number (directory `extra`), shared with the soundtrack. */
  group: number;
  width: number;
  height: number;
  fps: number;
  /** Surreal header duration in ms (ASF *send* duration; see asfPlayDuration for the picture's). */
  durationMs: number;
  /** Frame count estimated from the header. */
  frameCount: number;
  /** Size of the embedded ASF entry in bytes. */
  streamBytes: number;
  header: SrscEntry;
  data: SrscEntry;
}

/** Lists the videos of an in-memory .vdu. `pkg` is the package id from its .db. */
export function listVideos(file: SrscFile, pkg = 0): VideoInfo[] {
  return pairVideoEntries(file.entries)
    .map(([h, d]) => videoInfoFromHeader(file.data(h), h, d, pkg))
    .sort((a, b) => a.id - b.id);
}

/** Matches header entries (0x42) with their ASF data entries (0x43) by id. */
export function pairVideoEntries(entries: SrscEntry[]): [header: SrscEntry, data: SrscEntry][] {
  const data = new Map<number, SrscEntry>();
  for (const e of entries) if (e.type === VIDEO_DATA_TYPE) data.set(e.id, e);
  const out: [SrscEntry, SrscEntry][] = [];
  for (const h of entries) {
    const d = h.type === VIDEO_HEADER_TYPE && h.size >= 24 ? data.get(h.id) : undefined;
    if (d) out.push([h, d]);
  }
  return out;
}

/** Builds a VideoInfo from a header entry's bytes. */
export function videoInfoFromHeader(v: DataView, header: SrscEntry, data: SrscEntry, pkg = 0): VideoInfo {
  const fps = v.getUint32(4, true) || 30;
  const durationMs = v.getUint32(8, true);
  return {
    key: `${pkg}:${header.id}`,
    pkg,
    id: header.id,
    group: header.extra,
    width: v.getUint32(12, true),
    height: v.getUint32(16, true),
    fps,
    durationMs,
    frameCount: Math.round((durationMs * fps) / 1000),
    streamBytes: data.size,
    header,
    data,
  };
}

// ---------------------------------------------------------------------------
// ASF top-level facts (object layout per the public ASF specification)

const ASF_HEADER = '3026b2758e66cf11a6d900aa0062ce6c';
const ASF_SIMPLE_INDEX = '90080033b1e5cf1189f400a0c90349cb';
const ASF_FILE_PROPERTIES = 'a1dcab8c47a9cf118ee400c00c205365';

const guid = (b: Uint8Array, p: number) => Array.from(b.subarray(p, p + 16), (x) => x.toString(16).padStart(2, '0')).join('');
const u64 = (v: DataView, p: number) => v.getUint32(p, true) + v.getUint32(p + 4, true) * 2 ** 32;

/** The data entry's bytes from the Header object on (drops the leading Simple Index copy). */
export function asfStream(entry: Uint8Array): Uint8Array {
  if (entry.length >= 24 && guid(entry, 0) === ASF_SIMPLE_INDEX) {
    const size = u64(new DataView(entry.buffer, entry.byteOffset, entry.byteLength), 16);
    if (size >= 24 && size < entry.length) return entry.subarray(size);
  }
  return entry;
}

/**
 * Picture duration in seconds from the ASF File Properties object (play
 * duration minus preroll). `bytes` must start at the data entry (or at the
 * Header object) and include the Header object; returns undefined otherwise.
 */
export function asfPlayDuration(bytes: Uint8Array): number | undefined {
  const b = asfStream(bytes);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 30 || guid(b, 0) !== ASF_HEADER) return undefined;
  const end = Math.min(b.length, u64(v, 16));
  for (let p = 30; p + 24 <= end; ) {
    const size = u64(v, p + 16);
    if (size < 24) break;
    if (guid(b, p) === ASF_FILE_PROPERTIES && p + 88 <= end) {
      // object header 24, file id 16, file size 8, creation date 8, packet count 8,
      // play duration 8 (100 ns units), send duration 8, preroll 8 (ms)
      const play = u64(v, p + 64) / 1e7;
      const preroll = u64(v, p + 80) / 1000;
      return Math.max(0, play - preroll);
    }
    p += size;
  }
  return undefined;
}

/** Bytes of the data entry to read so asfPlayDuration() can answer (header objects are small). */
export const ASF_HEADER_PROBE = 64 * 1024;

// ---------------------------------------------------------------------------
// Soundtrack pairing
//
// Objective rule, verified on all retail data:
//   1. same asset group: the .vdu directory `extra` of the video == the .sdu `extra` of the sound,
//   2. sound category "movie" (3) preferred,
//   3. several videos in one group (Docks 34:1-3, logos 5:30/5:31): assignment minimising
//      |sound duration - video duration|, ties (< 0.1 s) broken by id order.
// A long looping movie sound (5:32 menu background -> 5:72, 111.6 s) is a music bed that
// loops independently of the picture ('bed'); everything else is muxed into the converted
// video ('sync').
// Pairings: 5:16->24 (intro), 5:30->73, 5:31->74 (logos), 5:32->72 (bed), 34:1->60, 34:2->61,
// 34:3->62, 34:4->59, 34:5->80, 12:2->355, 12:4->489, 12:5->490, 17:1->301, 17:2->302,
// 28:1->122, 28:2->123, 40:1->200, 39:1->216. Silent: 5:5-15 (menu backgrounds),
// 5:19/20/22/25/27/28/29 (transitions). Level clips' sounds run 1-2 s past the picture.

export interface SoundtrackPick {
  sound: SoundInfo;
  mode: 'sync' | 'bed';
  /** Human-readable reason (debugging / docs). */
  pairing: string;
}

/**
 * Picks the soundtrack of `video` among `sounds` (the package's .sdu) given every
 * video of the same .vdu with its picture duration.
 */
export function findSoundtrack(
  video: { id: number; group: number; durationSec: number },
  videos: { id: number; group: number; durationSec: number }[],
  sounds: SoundInfo[],
): SoundtrackPick | null {
  const inGroup = sounds.filter((s) => s.group === video.group);
  const movies = inGroup.filter((s) => s.category === SoundCategory.Movie);
  const cands = (movies.length ? movies : inGroup).sort((a, b) => a.id - b.id);
  if (!cands.length) return null;
  const peers = videos.filter((v) => v.group === video.group).sort((a, b) => a.id - b.id);
  const cost = (v: { durationSec: number }, s: SoundInfo) => Math.abs(s.duration - v.durationSec);
  let pick: SoundInfo | undefined;
  let how: string;
  if (peers.length > 1 && cands.length >= peers.length && peers.length <= 7) {
    // Optimal assignment; permutations come in lexicographic order and only strictly better ones win.
    let best: number[] | undefined;
    let bestCost = Infinity;
    const perm = (used: boolean[], cur: number[]) => {
      if (cur.length === peers.length) {
        const c = cur.reduce((sum, si, vi) => sum + cost(peers[vi], cands[si]), 0);
        if (c < bestCost - 0.1) {
          bestCost = c;
          best = [...cur];
        }
        return;
      }
      for (let i = 0; i < cands.length; i++)
        if (!used[i]) {
          used[i] = true;
          cur.push(i);
          perm(used, cur);
          cur.pop();
          used[i] = false;
        }
    };
    perm([], []);
    pick = best && cands[best[peers.findIndex((v) => v.id === video.id)]];
    how = `group ${video.group}: ${peers.length} videos/${cands.length} sounds assigned by duration (ties by id order)`;
  } else {
    pick = cands.reduce((a, b) => (cost(video, b) < cost(video, a) - 0.1 ? b : a));
    how = `group ${video.group}: closest duration of ${cands.length} candidate(s)`;
  }
  if (!pick) return null;
  const bed = pick.loop && pick.duration > video.durationSec + 5;
  if (!bed && cost(video, pick) > 2.5 + video.durationSec * 0.05) return null;
  return {
    sound: pick,
    mode: bed ? 'bed' : 'sync',
    pairing: `${how}; ${pick.duration.toFixed(2)} s sound vs ${video.durationSec.toFixed(2)} s video${bed ? ' (looping music bed)' : ''}`,
  };
}
