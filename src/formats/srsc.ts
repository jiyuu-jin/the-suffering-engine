// SRSC: the Riot Engine resource container used by every .?du and .lvl file.
//
// Header (14 bytes):
//   char[4] magic "SRSC"
//   u16     version (0x0101)
//   u32     directory offset
//   u16     entry count
// Directory (at `directory offset`, `count` entries of 14 bytes):
//   u8  type    resource type, meaning depends on the container (.tdu/.mdu/...)
//   u8  group
//   u16 id
//   u16 extra
//   u32 offset  absolute file offset of the payload
//   u32 size    payload size in bytes
// Entry 0 is typically type 0x02/group 0x04 and points at a small header block.

export interface SrscEntry {
  index: number;
  type: number;
  group: number;
  id: number;
  extra: number;
  offset: number;
  size: number;
}

export class SrscFile {
  readonly version: number;
  readonly entries: SrscEntry[];

  constructor(readonly buffer: ArrayBuffer) {
    const view = new DataView(buffer);
    const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
    if (magic !== 'SRSC') throw new Error(`Not an SRSC file (magic "${magic}")`);
    this.version = view.getUint16(4, true);
    const dirOffset = view.getUint32(6, true);
    const count = view.getUint16(10, true);
    this.entries = [];
    for (let i = 0; i < count; i++) {
      const p = dirOffset + i * 14;
      this.entries.push({
        index: i,
        type: view.getUint8(p),
        group: view.getUint8(p + 1),
        id: view.getUint16(p + 2, true),
        extra: view.getUint16(p + 4, true),
        offset: view.getUint32(p + 6, true),
        size: view.getUint32(p + 10, true),
      });
    }
  }

  data(entry: SrscEntry): DataView {
    return new DataView(this.buffer, entry.offset, entry.size);
  }

  bytes(entry: SrscEntry): Uint8Array {
    return new Uint8Array(this.buffer, entry.offset, entry.size);
  }

  byType(type: number): SrscEntry[] {
    return this.entries.filter((e) => e.type === type);
  }
}
