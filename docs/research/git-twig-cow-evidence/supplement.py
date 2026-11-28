#!/usr/bin/env python3
"""Small APFS correctness/metadata probes; only a new scratch root is mutated."""
import argparse
import hashlib
import json
import mmap
import os
from pathlib import Path
import subprocess
import time

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--root', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--twig', type=Path, required=True)
p.add_argument('--probe', type=Path, required=True)
a = p.parse_args()
a.root.mkdir()
a.output.mkdir()
os.umask(0o022)
stock = '/opt/homebrew/bin/git'
pwr = '/Applications/PwrGit.app/Contents/Resources/git/bin/git'
env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
env.update(GIT_CONFIG_GLOBAL=str(a.output / 'config'), GIT_CONFIG_SYSTEM=str(a.output / 'config'),
           GIT_CONFIG_NOSYSTEM='1', GIT_AUTHOR_NAME='CoW probe', GIT_COMMITTER_NAME='CoW probe',
           GIT_AUTHOR_EMAIL='cow@example.invalid', GIT_COMMITTER_EMAIL='cow@example.invalid',
           TWIG_TRACE='1', PATH=f'{a.twig.parent}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL='C')
(a.output / 'config').write_text('[core]\n\tautocrlf=false\n\thooksPath=/dev/null\n')
log = (a.output / 'commands.jsonl').open('w')
out = {}


def run(cmd, cwd=None):
    cmd = list(map(str, cmd))
    r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True)
    log.write(json.dumps(dict(command=cmd, cwd=str(cwd), exit=r.returncode,
                              stdout=r.stdout.decode(errors='replace'), stderr=r.stderr.decode(errors='replace'))) + '\n')
    log.flush()
    return r


def git(repo, *cmd, arm='stock'):
    binary = pwr if arm in ('on', 'off') else stock
    prefix = ['-c', 'checkout.reflink=' + str(arm == 'on').lower()] if binary == pwr else []
    return run([binary, *prefix, '-C', repo, *cmd])


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def create(repo, arm, target):
    if arm == 'twig':
        return git(repo, 'twig', 'new', '--detach', target, 'HEAD')
    return git(repo, 'worktree', 'add', '--detach', target, 'HEAD', arm=arm)


def set_xattr(path, name, value):
    r = run(['/usr/bin/xattr', '-w', name, value, path])
    if r.returncode:
        raise RuntimeError(r.stderr.decode())


def xattrs(path):
    names = run(['/usr/bin/xattr', path]).stdout.decode().splitlines()
    return {k: ''.join(run(['/usr/bin/xattr', '-px', k, path]).stdout.decode().split()).lower() for k in names}


try:
    repo = a.root / 'mapped-donor'
    git(a.root, 'init', '-q', '-b', 'main', repo)
    file = repo / 'data'
    file.write_bytes(b'A' * 65536)
    f = file.open('r+b')
    mm = mmap.mmap(f.fileno(), 0)
    mm[0] = ord('B')
    mm.flush()
    time.sleep(1.1)
    git(repo, 'add', 'data')
    git(repo, 'commit', '-qm', 'mapped first write committed')
    committed = git(repo, 'show', 'HEAD:data').stdout
    expected = hashlib.sha256(committed).hexdigest()
    git(repo, 'status', '--porcelain=v1')
    # The page remains dirty after this first subsequent write. Capture the
    # resulting mtime/ctime, then index those bytes in a second commit.
    mm[1] = ord('C')
    time.sleep(1.1)
    git(repo, 'add', 'data')
    git(repo, 'commit', '-qm', 'second mapped write committed')
    committed = git(repo, 'show', 'HEAD:data').stdout
    expected = hashlib.sha256(committed).hexdigest()
    time.sleep(1.1)
    before = file.stat()
    mm[2] = ord('D')
    after = file.stat()
    out['mapped_donor'] = dict(mtime_before=before.st_mtime_ns, mtime_after=after.st_mtime_ns,
                               ctime_before=before.st_ctime_ns, ctime_after=after.st_ctime_ns,
                               expected_sha256=expected, source_sha256=sha(file), arms={})
    for arm in ['stock', 'twig', 'on', 'off']:
        target = a.root / ('mapped-' + arm)
        r = create(repo, arm, target)
        out['mapped_donor']['arms'][arm] = dict(exit=r.returncode, stderr=r.stderr.decode(),
            sha256=sha(target / 'data') if (target / 'data').exists() else None,
            status=git(target, 'status', '--porcelain=v1').stdout.decode() if target.exists() else None)
    mm.close()
    f.close()

    # Metadata creation: a normal xattr is intentionally not part of a Git tree.
    repo = a.root / 'metadata'
    git(a.root, 'init', '-q', '-b', 'main', repo)
    file = repo / 'data'
    file.write_bytes(b'xattr fixture\n' * 4096)
    set_xattr(file, 'com.pwrgit.cow-test', 'private fixture metadata')
    set_xattr(file, 'com.apple.quarantine', '0081;00000000;CoWTest;')
    (repo / 'executable').write_text('#!/bin/sh\n')
    (repo / 'executable').chmod(0o755)
    (repo / 'link').symlink_to('data')
    aged = time.time_ns() - 20_000_000_000
    for path in [file, repo / 'executable']:
        os.utime(path, ns=(aged, aged))
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'metadata fixture')
    out['metadata'] = {}
    for arm in ['stock', 'twig', 'on', 'off']:
        target = a.root / ('metadata-' + arm)
        r = create(repo, arm, target)
        path = target / 'data'
        attrs = xattrs(path)
        out['metadata'][arm] = dict(exit=r.returncode, stderr=r.stderr.decode(), xattrs=attrs,
            executable_mode=oct((target / 'executable').stat().st_mode & 0o777),
            link=os.readlink(target / 'link'), mtime_ns=path.stat().st_mtime_ns,
            donor_mtime_ns=file.stat().st_mtime_ns,
            reflink_marker=git(target, 'rev-parse', '--git-path', 'reflink-source').stdout.decode().strip())
        marker = Path(out['metadata'][arm]['reflink_marker'])
        out['metadata'][arm]['marker_exists'] = (marker if marker.is_absolute() else target / marker).exists()
    target = a.root / 'metadata-off'
    # Re-share metadata belongs to the target; use custom xattr + quarantine.
    set_xattr(target / 'data', 'com.pwrgit.target', 'target-owned')
    set_xattr(target / 'data', 'com.apple.quarantine', '0081;00000001;Target;')
    before_hashes = {n: sha(target / n) for n in ['data', 'executable']}
    before_meta = xattrs(target / 'data')
    dry = git(target, 'worktree', 'reflink', '-n', '--porcelain', '-z', arm='on')
    apply = git(target, 'worktree', 'reflink', '--porcelain', '-z', arm='on')
    out['metadata_reshare'] = dict(before_hashes=before_hashes,
        after_hashes={n: sha(target / n) for n in ['data', 'executable']},
        before_xattrs=before_meta,
        after_xattrs=xattrs(target / 'data'),
        dry=dry.stdout.decode(), apply=apply.stdout.decode(),
        dry_exit=dry.returncode, apply_exit=apply.returncode,
        probe=run([a.probe, target / 'data', repo / 'data']).stdout.decode())
    # Small clean reset and dirty reset record every tracked file digest.
    out['reset_hashes'] = []
    for arm in ['stock', 'twig', 'on', 'off']:
        target = a.root / ('metadata-' + arm)
        for dirty in [False, True]:
            if dirty:
                (target / 'data').write_bytes(b'dirty\n')
            names = git(target, 'ls-files', '-z').stdout.decode().strip('\0').split('\0')
            def snapshot():
                return {n: ['symlink', os.readlink(target / n)] if (target / n).is_symlink()
                        else [oct((target / n).stat().st_mode & 0o777), sha(target / n)] for n in names}
            before = snapshot()
            r = git(target, 'reset', '--hard', 'HEAD', arm=arm)
            out['reset_hashes'].append(dict(arm=arm, dirty=dirty, before=before, after=snapshot(), exit=r.returncode))

    # A literal main-checkout move drops a path that both children still have.
    repo = a.root / 'drift'
    git(a.root, 'init', '-q', '-b', 'main', repo)
    for name in ['stable', 'old-only']:
        (repo / name).write_bytes(name.encode() * 8192)
        os.utime(repo / name, (time.time() - 20, time.time() - 20))
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'old')
    old = git(repo, 'rev-parse', 'HEAD').stdout.decode().strip()
    (repo / 'old-only').unlink()
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'main drops old-only')
    git(repo, 'switch', '--detach', old)
    child = a.root / 'drift-private'
    sibling = a.root / 'drift-sibling'
    create(repo, 'off', child)
    create(repo, 'on', sibling)
    git(repo, 'switch', 'main')
    names = ['stable', 'old-only']
    def drift_snapshot():
        return {n: sha(child / n) for n in names}
    before = drift_snapshot()
    apply = git(child, 'worktree', 'reflink', '--porcelain', '-z', arm='on')
    after = drift_snapshot()
    results = dict(before=before, after=after, reshare_exit=apply.returncode,
                   porcelain=apply.stdout.decode())
    before = drift_snapshot()
    git(child, 'reset', '--hard', old, arm='on')
    results['reset'] = dict(before=before, after=drift_snapshot())
    git(child, 'switch', '--detach', 'main', arm='on')
    git(child, 'switch', '--detach', old, arm='on')
    results['after_switch'] = drift_snapshot()
    results['probe'] = run([a.probe, *[p / n for p in [repo, sibling, child] for n in names if (p / n).exists()]]).stdout.decode()
    out['literal_drift'] = results
finally:
    (a.output / 'results.json').write_text(json.dumps(out, indent=2) + '\n')
    log.close()
