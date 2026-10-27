#!/usr/bin/env python3
"""Read APFS clone evidence for two disposable worktrees, plus a plain control.

Uses the same kernel attributes as DiskHound's clone_attrs.rs, independently
read with Python ctypes. No st_blocks/free-space inference and no deletion.
Only --self-test writes files, inside its own temporary directory.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import tempfile

class AttrList(ctypes.Structure):
    _fields_ = [('bitmapcount', ctypes.c_uint16), ('reserved', ctypes.c_uint16),
                ('commonattr', ctypes.c_uint32), ('volattr', ctypes.c_uint32),
                ('dirattr', ctypes.c_uint32), ('fileattr', ctypes.c_uint32),
                ('forkattr', ctypes.c_uint32)]

libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
libc.getattrlist.argtypes = [ctypes.c_char_p, ctypes.POINTER(AttrList), ctypes.c_void_p,
                            ctypes.c_size_t, ctypes.c_uint]
libc.getattrlist.restype = ctypes.c_int
# macOS SDK sys/attr.h, sys/stat.h: returned attrs; data allocation; private
# size, real device, clone ID, extended flags, clone reference count.
FORK = 0x8 | 0x40 | 0x100 | 0x200 | 0x1000

def attrs(path):
    a = AttrList(5, 0, 0x80000000, 0, 0, 0x400, FORK)
    b = ctypes.create_string_buffer(80)
    # NOFOLLOW | PACK_INVAL_ATTRS | ATTR_CMN_EXTENDED | NOFOLLOW_ANY
    if libc.getattrlist(os.fsencode(path), ctypes.byref(a), b, len(b), 0x829):
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()), str(path))
    length, common, vol, directory, filemask, fork = struct.unpack_from('=6I', b.raw)
    if length < 64 or (fork & FORK) != FORK or not filemask & 0x400:
        raise RuntimeError(f'APFS clone attributes incomplete for {path}: {fork:#x}')
    allocated, private, device, clone_id, flags, refcnt = struct.unpack_from('=QQiQQI', b.raw, 24)
    return dict(allocatedReferenceBytes=allocated, privateBytes=private,
                realDevice=device, cloneId=clone_id, extendedFlags=flags, cloneRefcount=refcnt)

def full_pair(a, b):
    return (a['realDevice'] == b['realDevice'] and a['cloneId'] != 0
            and a['cloneId'] == b['cloneId'] and min(a['cloneRefcount'], b['cloneRefcount']) >= 2
            and a['extendedFlags'] & 0x40 and b['extendedFlags'] & 0x40)

def hash_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def self_test():
    with tempfile.TemporaryDirectory(prefix='pwrgit-share-apfs-control-', dir='/private/tmp') as tmp:
        p = Path(tmp); donor, clone, ordinary = (p / s for s in ('donor', 'clone', 'ordinary'))
        donor.write_bytes(bytes(range(256)) * 4096)
        with donor.open('rb') as f: os.fsync(f.fileno())
        libc.clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        libc.clonefile.restype = ctypes.c_int
        if libc.clonefile(os.fsencode(donor), os.fsencode(clone), 0):
            raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
        ordinary.write_bytes(donor.read_bytes())
        with ordinary.open('rb') as f: os.fsync(f.fileno())
        a, b, c = [attrs(x) for x in (donor, clone, ordinary)]
        assert full_pair(a, b) and not full_pair(a, c), (a, b, c)
        assert a['privateBytes'] == b['privateBytes'] == 0
        original = hash_file(donor)
        with clone.open('r+b') as f:
            f.seek(16384); f.write(b'changed'); f.flush(); os.fsync(f.fileno())
        after = attrs(clone)
        assert hash_file(donor) == original
        assert after['cloneId'] != a['cloneId'] and after['privateBytes'] > 0, after
        assert all(x.stat().st_nlink == 1 for x in (donor, clone, ordinary))
        assert len({(x.stat().st_dev, x.stat().st_ino) for x in (donor, clone, ordinary)}) == 3
        return dict(clone=a, ordinaryCopy=c, cloneAfterWrite=after, passed=True)

def audit(donor, recipient, control):
    if len({p.resolve() for p in (donor, recipient, control)}) != 3:
        raise ValueError('donor, recipient, and control must be distinct directories')
    paths = subprocess.check_output(['git', '-C', str(donor), 'ls-files', '--stage', '-z']).split(b'\0')
    result = dict(regularFiles=0, logicalBytes=0, fullClonePairs=0, sharedLogicalBytes=0,
                  sharedAllocatedReferenceBytes=0, recipientPrivateBytes=0, controlFullClonePairs=0,
                  controlPrivateBytes=0, skippedEntries=0)
    mismatches, samples = [], []
    for entry in filter(None, paths):
        meta, raw = entry.split(b'\t', 1); mode = meta.split(b' ')[0]
        rel = Path(os.fsdecode(raw))
        if mode not in (b'100644', b'100755'):
            result['skippedEntries'] += 1; continue
        source, target, normal = [root / rel for root in (donor, recipient, control)]
        metadata = [os.lstat(x) for x in (source, target, normal)]
        assert all(stat.S_ISREG(m.st_mode) and m.st_nlink == 1 for m in metadata), rel
        assert len({(m.st_dev, m.st_ino) for m in metadata}) == 3, rel
        assert hash_file(source) == hash_file(target) == hash_file(normal), rel
        a, b, c = [attrs(x) for x in (source, target, normal)]
        size = source.stat().st_size
        result['regularFiles'] += 1; result['logicalBytes'] += size
        result['recipientPrivateBytes'] += b['privateBytes']; result['controlPrivateBytes'] += c['privateBytes']
        if full_pair(a, b):
            result['fullClonePairs'] += 1; result['sharedLogicalBytes'] += size
            result['sharedAllocatedReferenceBytes'] += b['allocatedReferenceBytes']
        elif size:
            mismatches.append(str(rel))
        if full_pair(a, c): result['controlFullClonePairs'] += 1
        samples.append(dict(path=str(rel), logicalBytes=size, donor=a, recipient=b, control=c))
    result['nonemptyUnsharedPaths'] = mismatches
    result['largestSamples'] = sorted(samples, key=lambda r:r['logicalBytes'], reverse=True)[:3]
    return result

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--self-test', action='store_true')
    p.add_argument('--donor', type=Path); p.add_argument('--recipient', type=Path); p.add_argument('--control', type=Path)
    a = p.parse_args()
    if a.self_test: print(json.dumps(self_test(), indent=2))
    elif all((a.donor, a.recipient, a.control)):
        print(json.dumps(audit(a.donor.resolve(), a.recipient.resolve(), a.control.resolve()), indent=2))
    else: p.error('provide --self-test or all three worktree paths')
