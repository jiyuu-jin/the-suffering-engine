#!/usr/bin/env python3
# Generator for src/formats/message-maps.ts: the complete message slots of every class the
# object factories create, recovered from Suffering.rfl (game classes) and SUFFERING.EXE
# (engine classes: lights, portals, ...). docs/re/object-model.md explains layout and method.
#
#   python3 tools/re/message_maps.py [game/app] > src/formats/message-maps.ts
#
# Needs: pip install --user capstone pefile. Reads the user's own install; writes only derived
# numbers (slot indices, message ids, addresses), no code or text from the binaries.
#
# Steps (per module)
#   1. Rebuild .data as it is after the C++ static initialisers ran: message maps are -1 / 0
#      in the file and filled by straight-line initialiser functions (the pointer table at the
#      start of .data). A tiny register tracker replays their stores.
#   2. Find every map registration: `push <map>; call [reg+0x34]` (the engine's "register
#      message map" virtual on the object's engine interface).
#   3. Class descriptor table -> object factory case (`cmp reg, classId` inside the factory's
#      compare tree; `push size; call alloc; ...; call ctor`, possibly through a shared tail)
#      -> constructor chain (each constructor calls its base constructor first) -> the maps it
#      registers and the vtable it installs.
#   4. A map is a list of 28-byte records {i32 message, i32 property, handler, 4 more words}:
#        message -1, property P   input slot: runs when the message equals the value of P
#        message M, property -1   fixed input: runs when message M arrives (engine ids too)
#        -2, -2, ..., parent      chain record (last word): continue with the parent's map
#        -1, -1                   end
#   5. Catch-all receivers (RFL): vtable slot 10 (+0x28) is the "any message" hook; the default
#      0x1001f750 returns 0. Overrides: message filters (0x100cb7a0: test, then forward to the
#      links), Characters (0x100e1e20: hand the message to the behaviour stack), Level
#      Transition Msg Handler (0x101369b0: store for another level), a few with own code.
#   6. Outputs: calls of the dispatcher `[global]->vt[1](ownHandle, propIndex, sender)` in the
#      class's vtable functions and map handlers and the functions they call (2 levels), own
#      handle only; computed indices (`neg/sbb/add`, `and/or`) give both values. Only
#      Enum-typed (0x11) properties of the class are kept.
import sys, re, struct, json, os

try:
    import pefile, capstone
except ImportError:
    sys.exit('needs: pip install --user capstone pefile')

ROOT = sys.argv[1] if len(sys.argv) > 1 else 'game/app'
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
md.skipdata = True
REGS = ('eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp')


def is_imm(s):
    return re.fullmatch(r'-?0x[0-9a-f]+|-?\d+', s) is not None


class Module:
    def __init__(self, path, cfg):
        self.cfg = cfg
        self.pe = pefile.PE(path, fast_load=True)
        self.base = self.pe.OPTIONAL_HEADER.ImageBase
        sect = lambda n: [s for s in self.pe.sections if s.Name.rstrip(b'\0') == n][0]
        text, data, rdata = sect(b'.text'), sect(b'.data'), sect(b'.rdata')
        self.T0 = self.base + text.VirtualAddress
        self.tdata = text.get_data()[: text.Misc_VirtualSize]
        self.T1 = self.T0 + len(self.tdata)
        self.D0 = self.base + data.VirtualAddress
        self.R0 = self.base + rdata.VirtualAddress
        self.R1 = self.R0 + rdata.Misc_VirtualSize
        self.img = bytearray(data.get_data()[: data.Misc_VirtualSize].ljust(data.Misc_VirtualSize, b'\0'))
        self._body = {}
        a0, a1 = cfg['init']
        for a in range(a0, a1, 4):
            f = self.u32(a)
            if self.T0 <= f < self.T1:
                self.replay(f)
        self.reg = self.registrations()

    # -- memory --------------------------------------------------------------------------------
    def read(self, va, n):
        return self.pe.get_data(va - self.base, n)

    def u32(self, va):
        return struct.unpack('<I', self.read(va, 4))[0]

    def dw(self, a):
        return struct.unpack_from('<I', self.img, a - self.D0)[0]

    def sdw(self, a):
        return struct.unpack_from('<i', self.img, a - self.D0)[0]

    def dis(self, va, n):
        return list(md.disasm(self.read(va, n), va))

    # -- 1. static initialisers ----------------------------------------------------------------
    def replay(self, fn):
        r, stack = {}, []
        for i in md.disasm(self.read(fn, 0x8000), fn):
            mn, op = i.mnemonic, i.op_str
            ops = [x.strip() for x in op.split(',')] if op else []
            if mn in ('ret', 'int3') or mn.startswith('j'):
                return
            if mn == 'mov' and len(ops) == 2:
                v = int(ops[1], 0) & 0xFFFFFFFF if is_imm(ops[1]) else r.get(ops[1])
                m = re.fullmatch(r'dword ptr \[(0x[0-9a-f]+)\]', ops[0])
                if m:
                    a = int(m.group(1), 16)
                    if self.D0 <= a < self.D0 + len(self.img) and v is not None:
                        struct.pack_into('<I', self.img, a - self.D0, v)
                elif ops[0] in REGS:
                    r[ops[0]] = v
            elif mn == 'xor' and len(ops) == 2 and ops[0] == ops[1] and ops[0] in REGS:
                r[ops[0]] = 0
            elif mn == 'or' and len(ops) == 2 and ops[0] in REGS and ops[1] in ('0xffffffff', '-1'):
                r[ops[0]] = 0xFFFFFFFF
            elif mn == 'push':
                stack.append(r.get(op))
            elif mn == 'pop':
                v = stack.pop() if stack else None
                if op in REGS:
                    r[op] = v
            elif mn == 'call':
                for k in ('eax', 'ecx', 'edx'):
                    r[k] = None
            elif ops and ops[0] in REGS:
                r[ops[0]] = None

    # -- 2. registrations ----------------------------------------------------------------------
    def registrations(self):
        reg, pushes = {}, []
        for a, sz, mn, op in md.disasm_lite(self.tdata, self.T0):
            if mn == 'call' and re.fullmatch(r'dword ptr \[e[a-z]{2} \+ 0x34\]', op):
                for pa, pop in reversed(pushes[-4:]):
                    if is_imm(pop) and self.D0 <= int(pop, 0) < self.D0 + len(self.img):
                        reg[a] = int(pop, 0)
                        break
            if mn == 'push':
                pushes.append((a, op))
            if mn == 'ret':
                pushes = []
            pushes = pushes[-6:]
        return reg

    def parse_map(self, m):
        ents, parent, a = [], None, m
        for _ in range(300):
            if a + 28 > self.D0 + len(self.img):
                return None, None
            msg, prop = self.sdw(a), self.sdw(a + 4)
            if msg == -2 and prop == -2:
                parent = self.dw(a + 24)
                break
            if msg == -1 and prop == -1:
                break
            ents.append((msg, prop, self.dw(a + 8)))
            a += 28
        return ents, parent

    def closure(self, m):
        out, seen = [], set()
        while m and m not in seen:
            seen.add(m)
            ents, parent = self.parse_map(m)
            if ents is None:
                break
            out.append((m, ents))
            m = parent
        return out

    # -- 3. classes ----------------------------------------------------------------------------
    def cstr(self, a):
        s = b''
        while (c := self.read(a, 1)) != b'\0':
            s += c
            a += 1
        return s.decode('latin1')

    def classes(self):
        t, n = self.cfg['classes']
        out = []
        for k in range(n):
            r = struct.unpack('<7I', self.read(t + 28 * k, 28))
            types = []
            for g in range(r[5]):
                gp = self.u32(r[6] + 4 * g)
                cnt, tp = self.u32(gp), self.u32(gp + 4)
                types += [self.u32(tp + 4 * j) for j in range(cnt)]
            out.append({'id': r[0], 'name': self.cstr(r[3]), 'types': types})
        return out

    def factory(self, cid):
        lo, hi = self.cfg['factory']
        alloc_fn = '0x%x' % self.cfg['alloc']
        hits = []
        for pat in (b'\x81\xf9', b'\x3d', b'\x81\xfa', b'\x81\xfe', b'\x81\xff'):
            p = pat + struct.pack('<I', cid)
            hits += [self.T0 + m.start() for m in re.finditer(re.escape(p), self.tdata)]
        for h in hits:
            if not (lo <= h < hi):
                continue
            tgt = None
            for nxt in self.dis(h, 0x20)[1:3]:
                if nxt.mnemonic == 'jmp' and re.fullmatch(r'0x[0-9a-f]+', nxt.op_str):
                    nxt = self.dis(int(nxt.op_str, 16), 0x10)[0]  # shared `jne default`
                if nxt.mnemonic == 'je':
                    tgt = int(nxt.op_str, 16)
                    break
                if nxt.mnemonic == 'jne':
                    tgt = nxt.address + nxt.size
                    break
            if tgt is None:
                continue
            alloc, last_push, pc = False, None, tgt
            for _ in range(3):  # follow a jump into a shared tail
                jumped = False
                for i in self.dis(pc, 0xA0)[:40]:
                    if i.mnemonic == 'push':
                        last_push = i.op_str
                    if i.mnemonic == 'call' and not alloc:
                        if i.op_str == alloc_fn and last_push and is_imm(last_push):
                            alloc = True
                            continue
                        if re.fullmatch(r'0x[0-9a-f]+', i.op_str):
                            st = self.dis(int(i.op_str, 16), 8)
                            if len(st) > 1 and st[0].mnemonic == 'mov' and st[1].mnemonic == 'ret':
                                return ('stub', int(i.op_str, 16))  # returns a shared dummy object
                        break
                    if alloc and i.mnemonic == 'call' and re.fullmatch(r'0x[0-9a-f]+', i.op_str):
                        return ('ctor', int(i.op_str, 16))
                    if alloc and i.mnemonic == 'mov':
                        m = re.fullmatch(r'dword ptr \[eax\], (0x[0-9a-f]+)', i.op_str)
                        if m and self.R0 <= int(m.group(1), 16) < self.R1:
                            return ('vt', int(m.group(1), 16))
                    if alloc and i.mnemonic == 'jmp' and re.fullmatch(r'0x[0-9a-f]+', i.op_str):
                        pc, jumped = int(i.op_str, 16), True
                        break
                    if i.mnemonic == 'ret':
                        break
                if not jumped:
                    break
        return None

    def fn_scan(self, f):
        found, calls, vt = [], [], None
        for i in md.disasm(self.read(f, 0x600), f):
            if i.mnemonic in ('ret', 'int3'):
                break
            if i.address in self.reg:
                found.append(self.reg[i.address])
            if i.mnemonic == 'call' and re.fullmatch(r'0x[0-9a-f]+', i.op_str):
                calls.append(int(i.op_str, 16))
            m = re.fullmatch(r'dword ptr \[e(?:si|di|ax|bx|cx|bp)\], (0x[0-9a-f]+)', i.op_str)
            if i.mnemonic == 'mov' and m and self.R0 <= int(m.group(1), 16) < self.R1:
                vt = int(m.group(1), 16)
        return found, calls, vt

    def ctor_maps(self, f, depth=0, seen=None):
        seen = seen if seen is not None else set()
        if f in seen or depth > 10:
            return []
        seen.add(f)
        found, calls, _ = self.fn_scan(f)
        return (self.ctor_maps(calls[0], depth + 1, seen) if calls else []) + found

    def vt_len(self, vt):
        n = 0
        while n < 400 and self.T0 <= self.u32(vt + 4 * n) < self.T1:
            n += 1
        return n

    # -- 6. output fires -----------------------------------------------------------------------
    def body(self, f, limit=4000):
        if f in self._body:
            return self._body[f]
        seen, work, n = {}, [f], 0
        while work and n < limit:
            a = work.pop()
            while a not in seen and self.T0 <= a < self.T1 and n < limit:
                ins = next(md.disasm(self.read(a, 16), a), None)
                if ins is None:
                    break
                seen[a] = ins
                n += 1
                mn = ins.mnemonic
                if mn in ('ret', 'int3'):
                    break
                if mn == 'jmp':
                    mt = re.fullmatch(r'dword ptr \[e[a-z]{2}\*4 \+ (0x[0-9a-f]+)\]', ins.op_str)
                    if mt:  # jump table
                        tb = int(mt.group(1), 16)
                        for q in range(64):
                            t = self.u32(tb + 4 * q)
                            if not (abs(t - f) < 0x4000 and self.T0 <= t < self.T1):
                                break
                            work.append(t)
                    if re.fullmatch(r'0x[0-9a-f]+', ins.op_str) and abs(int(ins.op_str, 16) - f) < 0x4000:
                        work.append(int(ins.op_str, 16))
                    break
                if mn.startswith('j') and re.fullmatch(r'0x[0-9a-f]+', ins.op_str):
                    work.append(int(ins.op_str, 16))
                a += ins.size
        self._body[f] = [seen[k] for k in sorted(seen)]
        return self._body[f]

    def fires_in(self, f):
        g = '0x%x' % self.cfg['dispatcher']
        ins, out, calls = self.body(f), set(), set()
        for k, i in enumerate(ins):
            if i.mnemonic == 'call' and re.fullmatch(r'0x[0-9a-f]+', i.op_str):
                calls.add(int(i.op_str, 16))
            if i.mnemonic != 'call' or not re.fullmatch(r'dword ptr \[e[a-z]{2} \+ 4\]', i.op_str):
                continue
            win = ins[max(0, k - 14): k]
            if not any(g in x.op_str for x in win):
                continue
            ps = [x for x in win if x.mnemonic == 'push']
            if len(ps) < 3:
                continue
            hp, pp = ps[-1], ps[-2]
            own = re.fullmatch(r'dword ptr \[e[a-z]{2} \+ 4\]', hp.op_str) is not None
            if not own:
                for x in reversed(win):
                    if x.mnemonic == 'mov' and x.op_str.startswith(hp.op_str + ','):
                        own = re.search(r'\[e[a-z]{2} \+ 4\]$', x.op_str) is not None
                        break
            if not own:
                continue
            if is_imm(pp.op_str):
                out.add(int(pp.op_str, 0))
                continue
            for x in reversed(win):
                m = re.fullmatch(re.escape(pp.op_str) + r', (0x[0-9a-f]+|\d+)', x.op_str)
                if m and x.mnemonic == 'add':
                    v = int(m.group(1), 0)
                    out |= {v - 1, v}
                    break
                if m and x.mnemonic == 'or':
                    v = int(m.group(1), 0)
                    out |= {v, v | 1}
                    break
                if m and x.mnemonic == 'mov':
                    out.add(int(m.group(1), 0))
                    break
        return out, calls

    def class_outputs(self, vt, chain, depth=2):
        roots = {self.u32(vt + 4 * k) for k in range(self.vt_len(vt))} if vt else set()
        for _, ents in chain:
            roots |= {h for _, _, h in ents}
        found, seen, frontier = set(), set(), roots
        for _ in range(depth + 1):
            nxt = set()
            for f in frontier - seen:
                seen.add(f)
                o, c = self.fires_in(f)
                found |= o
                nxt |= c
            frontier = nxt
        return found

    def rows(self):
        out = []
        for c in self.classes():
            fac = self.factory(c['id'])
            if not fac:
                continue
            if fac[0] == 'stub':
                maps, vt = [], None
            elif fac[0] == 'vt':
                maps, vt = [], fac[1]
            else:
                maps = self.ctor_maps(fac[1])
                vt = self.fn_scan(fac[1])[2]
            chain = self.closure(maps[-1]) if maps else []
            types = c['types']
            enum = lambda p: 0 <= p < len(types) and types[p] == 0x11
            ins = sorted({p for _, e in chain for _, p, _ in e if p >= 0})
            fixed = sorted({m for _, e in chain for m, p, _ in e if p < 0})
            assert all(enum(p) for p in ins), (c['name'], ins)
            outs = set(self.class_outputs(vt, chain)) if 'dispatcher' in self.cfg else set()
            outs |= set(EXTRA_OUTPUTS.get(c['name'], []))
            catch, on_msg = '', 0
            if 'onMessageDefault' in self.cfg and vt and self.vt_len(vt) > 10:
                on_msg = self.u32(vt + 40)
                if on_msg != self.cfg['onMessageDefault']:
                    catch = CATCH_ALL.get(on_msg, 'handler')
                else:
                    on_msg = 0
            outs = sorted(p for p in outs if enum(p))
            # Destroy (GameObject map p12 -> vtable +0x88): the PhysicalObject version 0x1009b410
            # fires p21 to the links before removing the object (when its health is above 0).
            destroy_out = 21 if vt and self.vt_len(vt) > 34 and self.u32(vt + 0x88) == DESTROY_FIRES_21 and enum(21) else 0
            out.append((c['id'], c['name'], [m for m, _ in chain], ins, fixed, outs, catch, on_msg, destroy_out))
        return out


# Outputs fired from code the generic scan cannot attribute (computed in a helper object, or
# fired by another class on this object's handle).
EXTRA_OUTPUTS = {
    'Mechanism': [55, 56, 57, 58],  # motion group g fires 55 + 2g (+1): helper 0x100c8221
    'Switch': [68, 69],  # fired by the Player's use code on the switch: 0x100368f6, 0x100367f1
}
DESTROY_FIRES_21 = 0x1009B410
CATCH_ALL = {0x100CB7A0: 'filter', 0x100E1E20: 'behaviors', 0x101369B0: 'mailbox'}

RFL = {
    'init': (0x10167004, 0x101673F8),
    'classes': (0x10171DF8, 369),
    'factory': (0x10020000, 0x10024000),
    'alloc': 0x10006400,
    'dispatcher': 0x1017BF54,
    'onMessageDefault': 0x1001F750,
}
EXE = {
    'init': (0x5B4000, 0x5B5080),
    'classes': (0x5BB358, 19),
    'factory': (0x4DF000, 0x4E0000),
    'alloc': 0x401000,
}

rows = Module(os.path.join(ROOT, 'Suffering.rfl'), RFL).rows()
rows += Module(os.path.join(ROOT, 'SUFFERING.EXE'), EXE).rows()
rows.sort(key=lambda r: r[1].lower())
hx = lambda v: '0x%08x' % v
j = lambda xs: '[' + ', '.join(str(x) for x in xs) + ']'
print('''// GENERATED by tools/re/message_maps.py from Suffering.rfl and SUFFERING.EXE - do not edit by hand.
//
// Message maps of every class the object factories create (docs/re/object-model.md). Row:
//   [classId, name, mapChain, inputs, fixedInputs, outputs, catchAll, onMessageVA, destroyOutput]
//   mapChain     VAs of the class map and its parent maps (most derived first); [] = no map
//   inputs       property indices whose VALUE is the message that runs the handler
//   fixedInputs  message ids handled whatever the properties hold (engine ids >= 0x1000 too)
//   outputs      property indices fired to the links (own handle; Enum-typed only)
//   catchAll     '' | 'filter' (test, then forward to the links) | 'behaviors' (Character: to the
//                behaviour stack) | 'mailbox' (Level Transition Msg Handler) | 'handler' (own code)
//   destroyOutput  output fired to the links when a Destroy message removes the object (0 = none)
// A class with an empty mapChain and no catchAll receives no link message at all.

export type CatchAll = '' | 'filter' | 'behaviors' | 'mailbox' | 'handler';
export type MessageMapRow = [number, string, number[], number[], number[], number[], CatchAll, number, number];

export const MESSAGE_MAP_ROWS: MessageMapRow[] = [''')
for cid, name, chain, ins, fixed, outs, catch, onm, dout in rows:
    print(f'  [{hx(cid)}, {json.dumps(name)}, [{", ".join(hx(m) for m in chain)}], {j(ins)}, {j(fixed)}, {j(outs)}, {json.dumps(catch)}, {hx(onm) if onm else 0}, {dout}],')
print('];')
