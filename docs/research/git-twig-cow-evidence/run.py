#!/usr/bin/env python3
"""Destructive only inside a NEW --root; binaries and APFS mount are supplied.

Build Twig separately at the pinned tag. Run on a fresh case-sensitive APFS
image. All subprocesses, including unsuccessful ones, go to commands.jsonl.
This is a measurement harness, not an installed-product test or speed gate.
"""
import argparse
import concurrent.futures
import hashlib
import io
import itertools
import json
import mmap
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import tarfile
import time

STOCK = '/opt/homebrew/bin/git'
PWR = '/Applications/PwrGit.app/Contents/Resources/git/bin/git'
ARMS = ['stock', 'twig', 'on', 'off']
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--twig', type=Path, required=True)
parser.add_argument('--probe', type=Path, required=True)
parser.add_argument('--public-only', action='store_true')
parser.add_argument('--age-public-index', action='store_true')
parser.add_argument('--lifecycle-only', action='store_true')
parser.add_argument('--public-url', default='https://github.com/leostera/git-twig')
parser.add_argument('--public-revision', default='112840639a5d80b05d1d5426723be49f2a16dd83')
parser.add_argument('--public-name', default='public-twig')
parser.add_argument('--public-depth', type=int)
parser.add_argument('--public-reshare', action='store_true')
args = parser.parse_args()
args.root.mkdir()  # Refuse to reuse a previous test tree.
args.output.mkdir(parents=True, exist_ok=True)
os.umask(0o022)
env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
env.update(GIT_CONFIG_GLOBAL=str(args.output / 'global'),
           GIT_CONFIG_SYSTEM=str(args.output / 'system'),
           GIT_CONFIG_NOSYSTEM='1', LC_ALL='C', TZ='UTC', TWIG_TRACE='1',
           GIT_AUTHOR_NAME='CoW fixture', GIT_AUTHOR_EMAIL='cow@example.invalid',
           GIT_COMMITTER_NAME='CoW fixture', GIT_COMMITTER_EMAIL='cow@example.invalid',
           PATH=f'{args.twig.parent}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')
for f in ['global', 'system']:
    (args.output / f).write_text('[core]\n\tautocrlf = false\n\thooksPath = /dev/null\n')
log = (args.output / 'commands.jsonl').open('w')
results = {'timings': [], 'checks': [], 'allocation': [], 'operations': [], 'dirty': []}


def run(cmd, cwd=None, timed=False, check=True):
    cmd = [str(c) for c in cmd]
    actual = ['/usr/bin/time', '-l', *cmd] if timed else cmd
    started = time.time()
    p = subprocess.run(actual, cwd=cwd, env=env, capture_output=True)
    output = (f'<archive {len(p.stdout)} bytes sha256={hashlib.sha256(p.stdout).hexdigest()}>'
              if 'archive' in cmd else p.stdout.decode(errors='replace'))
    entry = dict(command=actual, cwd=str(cwd) if cwd else None,
                 exit=p.returncode, stdout=output,
                 stderr=p.stderr.decode(errors='replace'), epoch=started)
    log.write(json.dumps(entry) + '\n')
    log.flush()
    p.record = entry
    if timed:
        m = re.search(r'([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys', entry['stderr'])
        rss = re.search(r'(\d+)\s+maximum resident set size', entry['stderr'])
        p.metrics = dict(wall=float(m[1]), user=float(m[2]), system=float(m[3]),
                         rss_bytes=int(rss[1])) if m and rss else None
    if check and p.returncode:
        raise RuntimeError(entry)
    return p


def git(repo, *cmd, arm='stock', **kw):
    binary = PWR if arm in ('on', 'off') else STOCK
    prefix = ['-c', f'checkout.reflink={str(arm == "on").lower()}'] if binary == PWR else []
    before = None
    if cmd and cmd[0] == 'reset' and '--hard' in cmd:
        names = run([STOCK, '-C', repo, 'ls-files', '-z']).stdout.decode().strip('\0').split('\0')
        before = snapshot(repo, dict.fromkeys(names))
    response = run([binary, *prefix, '-C', repo, *cmd], **kw)
    if before is not None:
        names = run([STOCK, '-C', repo, 'ls-files', '-z']).stdout.decode().strip('\0').split('\0')
        after = snapshot(repo, dict.fromkeys(names))
        results.setdefault('reset_checks', []).append(dict(repo=str(repo), command=cmd,
            arm=arm, before=digest(before), after=digest(after), exit=response.returncode))
    return response


def commit(repo, message):
    # Old real mtimes avoid testing the unrelated racy-index exclusion.
    aged = time.time_ns() - 20_000_000_000
    for p in repo.rglob('*'):
        if '.git' not in p.parts and (p.is_file() or p.is_symlink()):
            os.utime(p, ns=(aged, aged), follow_symlinks=False)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', message)
    return git(repo, 'rev-parse', 'HEAD').stdout.decode().strip()


def fixture(name, count, size):
    repo = args.root / name
    git(args.root, 'init', '-q', '-b', 'main', repo)
    rng = random.Random(607)
    for i in range(count):
        p = repo / 'files' / f'{i // 64:03d}' / f'{i:05d}.bin'
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(rng.randbytes(size))
    (repo / 'script').write_text('#!/bin/sh\necho fixture\n')
    (repo / 'script').chmod(0o755)
    (repo / 'link').symlink_to('script')
    (repo / 'absolute-link').symlink_to('/fixture/does-not-exist')
    old = commit(repo, 'old')
    for i, p in enumerate(sorted((repo / 'files').rglob('*.bin'))):
        if i % 8 == 0:
            with p.open('r+b') as f:
                f.write(b'new bytes')
    (repo / 'script').rename(repo / 'renamed-script')
    (repo / 'link').unlink()
    (repo / 'link').symlink_to('renamed-script')
    head = commit(repo, 'new')
    return repo, old, head


def tree_oracle(repo, revision):
    archive = git(repo, 'archive', '--format=tar', revision).stdout
    # Archive bytes need not bloat command logs: retain its hash instead.
    inventory = {}
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for item in tar:
            if item.isfile():
                inventory[item.name] = ['file', bool(item.mode & 0o111),
                                         hashlib.sha256(tar.extractfile(item).read()).hexdigest()]
            elif item.issym():
                inventory[item.name] = ['link', item.linkname]
    return inventory


def snapshot(repo, inventory):
    actual = {}
    for name in inventory:
        p = repo / name
        if p.is_symlink():
            actual[name] = ['link', os.readlink(p)]
        elif p.is_file():
            actual[name] = ['file', bool(p.stat().st_mode & 0o111),
                            hashlib.sha256(p.read_bytes()).hexdigest()]
        else:
            actual[name] = ['missing']
    return actual


def digest(inventory):
    return hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()


def verify(repo, expected, label):
    actual = snapshot(repo, expected)
    record = dict(label=label, tree_sha256=digest(actual),
                  mismatches=[p for p in expected if actual[p] != expected[p]],
                  status=git(repo, 'status', '--porcelain=v1').stdout.decode(),
                  diff=git(repo, 'diff', '--raw').stdout.decode())
    results['checks'].append(record)
    return record


def probes(paths):
    if not paths:
        return {}
    lines = []
    for offset in range(0, len(paths), 256):
        lines.extend(run([args.probe, *paths[offset:offset + 256]]).stdout.decode().splitlines())
    return {line.split('\t', 2)[2]: dict(first_block=int(line.split('\t')[0]),
                                       private_bytes=int(line.split('\t')[1])) for line in lines}


def sharing(repo, target, expected):
    names = [n for n in expected if expected[n][0] == 'file']
    # All files: independent allocation signal plus first-extent equality.
    pairs = probes([p / n for p in (repo, target) for n in names])
    shared = sum(pairs[str(repo / n)]['first_block'] >= 0 and
                 pairs[str(repo / n)]['first_block'] == pairs[str(target / n)]['first_block'] for n in names)
    private = [pairs[str(target / n)]['private_bytes'] for n in names]
    return dict(files=len(names), same_first_extent=shared,
                zero_private=sum(v == 0 for v in private),
                private_bytes=sum(private) if all(v >= 0 for v in private) else None,
                sample={n: {'source': pairs[str(repo / n)], 'target': pairs[str(target / n)]}
                        for n in names[:3]})


serial = itertools.count(1)


def create(repo, rev, arm, label, timed=True):
    target = args.root / f'wt-{next(serial)}'
    if arm == 'twig':
        p = run([STOCK, '-C', repo, 'twig', 'new', '--detach', target, rev], timed=timed, check=False)
    else:
        p = git(repo, 'worktree', 'add', '--detach', target, rev, arm=arm, timed=timed, check=False)
    trace = p.stderr.decode(errors='replace')
    rec = dict(fixture=repo.name, revision=rev, arm=arm, label=label, exit=p.returncode,
               backend=('native' if 'CoW: verified tracked files' in trace else 'fallback') if arm == 'twig' else arm,
               metrics=p.metrics if timed else None, target=str(target))
    results['timings'].append(rec)
    return target, rec


def remove(repo, target):
    git(repo, 'worktree', 'remove', '--force', target)


def allocation():
    run(['/bin/sync'])
    time.sleep(0.3)
    v = os.statvfs(args.root)
    if shutil.disk_usage('/private/tmp').free < 40 * 1024**3:
        raise RuntimeError('Host headroom fell below 40 GiB')
    return (v.f_blocks - v.f_bfree) * v.f_frsize


def reshare(repo, expected, label):
    before = snapshot(repo, expected)
    old_stats = {n: [os.lstat(repo / n).st_ino, os.lstat(repo / n).st_mtime_ns] for n in expected}
    dry = git(repo, 'worktree', 'reflink', '-n', '--porcelain', '-z', arm='on', timed=True, check=False)
    apply = git(repo, 'worktree', 'reflink', '--porcelain', '-z', arm='on', timed=True, check=False)
    after = snapshot(repo, expected)
    record = dict(label=label, before=digest(before), after=digest(after),
                  changed=[n for n in before if before[n] != after[n]],
                  inode_changed=sum(old_stats[n][0] != os.lstat(repo / n).st_ino for n in expected),
                  mtime_changed=sum(old_stats[n][1] != os.lstat(repo / n).st_mtime_ns for n in expected),
                  dry=dry.stdout.decode(), apply=apply.stdout.decode(),
                  dry_exit=dry.returncode, apply_exit=apply.returncode,
                  dry_metrics=dry.metrics, apply_metrics=apply.metrics)
    results['operations'].append(record)
    return record


def save():
    (args.output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')


try:
    pins = {p: {'sha256': hashlib.sha256(Path(p).read_bytes()).hexdigest(),
                'version': run([p, '--version']).stdout.decode().strip()} for p in (STOCK, PWR, str(args.twig))}
    results['environment'] = dict(pins=pins, uname=list(os.uname()), umask='022',
                                  env={k: v for k, v in env.items() if k.startswith('GIT_') or k in ('PATH', 'LC_ALL', 'TZ', 'TWIG_TRACE')}, root=str(args.root),
                                  started=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
    fixtures = [] if args.public_only else [fixture('file-heavy', 4096, 1024)]
    if not args.public_only and not args.lifecycle_only:
        fixtures.append(fixture('byte-heavy', 32, 8 * 1024**2))
    public = args.root / args.public_name
    depth = ['--depth', str(args.public_depth)] if args.public_depth else []
    clone_revision = ['--revision', args.public_revision] if args.public_depth else []
    git(args.root, 'clone', '--quiet', *depth, *clone_revision, args.public_url, public)
    git(public, 'checkout', '--detach', args.public_revision)
    if args.age_public_index:
        aged = time.time_ns() - 20_000_000_000
        for path in public.rglob('*'):
            if '.git' not in path.parts and (path.is_file() or path.is_symlink()):
                os.utime(path, ns=(aged, aged), follow_symlinks=False)
        git(public, 'update-index', '--refresh')
    index_probe = 'Cargo.toml' if (public / 'Cargo.toml').is_file() else next(
        name for name in git(public, 'ls-files', '-z').stdout.decode().strip('\0').split('\0')
        if (public / name).is_file() and not (public / name).is_symlink())
    results['public_source'] = dict(url=args.public_url, requested_revision=args.public_revision,
                                    depth=args.public_depth)
    results['public_index'] = dict(aged=args.age_public_index, probe_path=index_probe,
        index_mtime_ns=(public / '.git/index').stat().st_mtime_ns,
        path_stat=[(public / index_probe).stat().st_mtime_ns, (public / index_probe).stat().st_ctime_ns],
        debug=git(public, 'ls-files', '--debug', index_probe).stdout.decode())
    fixtures.append((public, git(public, 'rev-parse', 'HEAD^').stdout.decode().strip(),
                     git(public, 'rev-parse', 'HEAD').stdout.decode().strip()))
    for repo, old, head in fixtures:
        results.setdefault('fixtures', []).append(dict(name=repo.name, old=old, head=head))
        if args.lifecycle_only:
            break
        for rev, revision_label in [(head, 'head'), (old, 'older')]:
            expected = tree_oracle(repo, rev)
            # Warm all source bytes and binary bytes once. Never drop page cache.
            snapshot(repo, tree_oracle(repo, head))
            for round_no in range(6):
                order = ARMS if round_no % 2 == 0 else list(reversed(ARMS))
                for arm in order:
                    target, rec = create(repo, rev, arm, f'{revision_label}-' + ('warmup' if round_no == 0 else str(round_no)))
                    if rec['exit'] == 0:
                        verify(target, expected, f'{repo.name}/{rec["label"]}/{arm}')
                        if round_no == 1:
                            rec['sharing'] = sharing(repo, target, expected)
                        remove(repo, target)
                save()
        # Allocation cohort: three simultaneous children, fresh private writes per arm.
        expected = tree_oracle(repo, head)
        for arm in ARMS:
            start = allocation()
            children = [create(repo, head, arm, 'allocation', False)[0] for _ in range(3)]
            end = allocation()
            results['allocation'].append(dict(fixture=repo.name, arm=arm, children=3,
                                               before=start, after=end, delta=end-start))
            for child in children:
                remove(repo, child)
        save()

    if args.public_reshare:
        expected = tree_oracle(public, 'HEAD')
        child, _ = create(public, 'HEAD', 'off', 'public-private-reshare')
        results['operations'].append(dict(label='public-before-reshare', sharing=sharing(public, child, expected)))
        reshare(child, expected, 'public-private-reshare')
        verify(child, expected, 'public-private-reshare')
        results['operations'].append(dict(label='public-after-reshare', sharing=sharing(public, child, expected)))
        git(child, 'reset', '--hard', 'HEAD', arm='on', timed=True)
        verify(child, expected, 'public-reset-after-reshare')
        remove(public, child)
        save()

    if args.public_only:
        print('Completed public-only:', args.output)
        raise SystemExit(0)

    # Correctness and lifecycle use the small fixture, avoiding unnecessary I/O.
    repo, old, head = fixtures[0]
    expected = tree_oracle(repo, head)
    path = next(n for n in expected if expected[n][0] == 'file' and n.endswith('.bin'))
    original = (repo / path).read_bytes()
    for kind in ['append', 'same-size', 'restored-mtime', 'symlink', 'mmap-stat']:
        git(repo, 'reset', '--hard', head)
        git(repo, 'status', '--porcelain')
        oldstat = os.stat(repo / path)
        mapping = None
        if kind == 'symlink':
            (repo / 'link').unlink()
            (repo / 'link').symlink_to('/dirty/target')
        elif kind == 'mmap-stat':
            f = (repo / path).open('r+b')
            mapping = mmap.mmap(f.fileno(), 0)
            mapping[0] ^= 1  # Dirty the page and timestamp first.
            mapping.flush()
            git(repo, 'add', path)
            donor_index_blob = git(repo, 'rev-parse', ':' + path).stdout.decode().strip()
            time.sleep(1.1)
            prewrite = os.stat(repo / path)
            mapping[1] ^= 1
            postwrite = os.stat(repo / path)
        else:
            (repo / path).write_bytes(original + b'dirty' if kind == 'append' else b'X' * len(original))
            if kind == 'restored-mtime':
                os.utime(repo / path, ns=(oldstat.st_atime_ns, oldstat.st_mtime_ns))
        changedstat = os.stat(repo / path)
        detail = dict(kind=kind, mtime_equal=oldstat.st_mtime_ns == changedstat.st_mtime_ns,
                      ctime_equal=oldstat.st_ctime_ns == changedstat.st_ctime_ns)
        if mapping:
            detail.update(mmap_mtime_equal=prewrite.st_mtime_ns == postwrite.st_mtime_ns,
                          mmap_ctime_equal=prewrite.st_ctime_ns == postwrite.st_ctime_ns,
                          donor_index_blob=donor_index_blob)
        for arm in ARMS:
            child, rec = create(repo, head, arm, 'dirty-' + kind)
            if not rec['exit']:
                detail[arm] = verify(child, expected, f'dirty/{kind}/{arm}')
                remove(repo, child)
        results['dirty'].append(detail)
        if mapping:
            mapping.close()
            f.close()
    git(repo, 'reset', '--hard', head)

    for arm in ARMS:
        child, _ = create(repo, head, arm, 'lifecycle')
        (child / path).write_bytes(b'edit\n')
        git(child, 'mv', 'renamed-script', 'moved-script', arm=arm)
        (child / 'moved-script').chmod(0o644)
        results['operations'].append(dict(label='edit-rename-mode/' + arm,
            status=git(child, 'status', '--porcelain', arm=arm, timed=True).stdout.decode(),
            diff=git(child, 'diff', '--raw', arm=arm, timed=True).stdout.decode()))
        before = snapshot(child, expected)
        git(child, 'reset', '--hard', head, arm=arm, timed=True)
        after = snapshot(child, expected)
        results['operations'].append(dict(label='reset-dirty/' + arm, before=digest(before), after=digest(after)))
        verify(child, expected, 'reset/' + arm)
        for revision in [old, head]:
            git(child, 'switch', '--detach', revision, arm=arm, timed=True)
            verify(child, tree_oracle(repo, revision), 'switch/' + arm)
        results['operations'].append(dict(label='after-switch/' + arm, sharing=sharing(repo, child, expected)))
        # A local bare remote, independent base and disjoint commits exercise real
        # merge, rebase and fast-forward pull without touching any user's repo.
        git(child, 'switch', '-c', f'life-{arm}', arm=arm)
        (child / 'local').write_text('local\n')
        local_commit = commit(child, 'local')
        git(repo, 'switch', '-c', f'upstream-{arm}', head)
        (repo / 'upstream').write_text('upstream\n')
        upstream = commit(repo, 'upstream')
        git(child, 'merge', '--no-edit', upstream, arm=arm, timed=True)
        verify(child, tree_oracle(repo, 'HEAD') | {'local': ['file', False, hashlib.sha256(b'local\n').hexdigest()]}, 'merge/' + arm)
        git(child, 'reset', '--hard', local_commit, arm=arm)
        git(child, 'rebase', upstream, arm=arm, timed=True)
        verify(child, tree_oracle(child, 'HEAD'), 'rebase/' + arm)
        remote = args.root / f'remote-{arm}.git'
        git(args.root, 'init', '--bare', '-q', remote)
        git(repo, 'push', remote, f'HEAD:refs/heads/main')
        git(child, 'reset', '--hard', upstream, arm=arm)
        (repo / 'pull-file').write_text('pull\n')
        commit(repo, 'pull')
        git(repo, 'push', remote, 'HEAD:refs/heads/main')
        git(child, 'pull', '--ff-only', remote, 'main', arm=arm, timed=True)
        verify(child, tree_oracle(repo, 'HEAD'), 'pull/' + arm)
        remove(repo, child)
        git(repo, 'switch', 'main')
        git(repo, 'reset', '--hard', head)
    save()

    # Force private copies of unchanged committed bytes; explicit re-share must
    # preserve the full tracked tree, including intentionally dirty files.
    child, _ = create(repo, head, 'off', 'reshare-private')
    for n in expected:
        if expected[n][0] == 'file':
            p = child / n
            data = p.read_bytes()
            with p.open('r+b') as f:
                f.write(data)
    git(child, 'status', '--porcelain')
    results['operations'].append(dict(label='before-reshare', sharing=sharing(repo, child, expected)))
    reshare(child, expected, 'private-reshare')
    verify(child, expected, 'private-reshare')
    results['operations'].append(dict(label='after-reshare', sharing=sharing(repo, child, expected)))
    (child / path).write_bytes(b'dirty preserved\n')
    (child / 'link').unlink()
    (child / 'link').symlink_to('/dirty/link')
    reshare(child, expected, 'dirty-reshare')
    before = snapshot(child, expected)
    git(child, 'reset', '--hard', head, arm='on', timed=True)
    results['operations'].append(dict(label='reset-after-reshare', before=digest(before), after=digest(snapshot(child, expected))))
    verify(child, expected, 'reset-after-reshare')
    remove(repo, child)

    # Selected main donor loses a blob, while a sibling still has it.
    sibling, _ = create(repo, old, 'on', 'drift-sibling')
    child, _ = create(repo, old, 'off', 'drift-private')
    old_expected = tree_oracle(repo, old)
    reshare(child, old_expected, 'drift-main-new-sibling-old')
    results['operations'].append(dict(label='drift-sharing', sharing=sharing(sibling, child, old_expected)))
    for rev in [head, old]:
        git(child, 'switch', '--detach', rev, arm='on', timed=True)
    before = snapshot(child, old_expected)
    git(child, 'reset', '--hard', old, arm='on', timed=True)
    results['operations'].append(dict(label='drift-reset', before=digest(before), after=digest(snapshot(child, old_expected)),
        sharing=sharing(sibling, child, old_expected)))
    verify(child, old_expected, 'drift-reset')
    remove(repo, sibling)
    remove(repo, child)

    # Writable mapping across APFS replacement: old inode remains accessible.
    child, _ = create(repo, head, 'off', 'mmap-replace')
    f = (child / path).open('r+b')
    mapping = mmap.mmap(f.fileno(), 0)
    inode = os.fstat(f.fileno()).st_ino
    reshare(child, expected, 'mmap-held-across-replace')
    mapping[0] ^= 1
    mapping.flush()
    results['operations'].append(dict(label='mmap-after-replace',
        inode_before=inode, inode_after=os.stat(child / path).st_ino,
        descriptor_sha256=hashlib.sha256(mapping[:]).hexdigest(),
        pathname_sha256=hashlib.sha256((child / path).read_bytes()).hexdigest()))
    mapping.close()
    f.close()
    verify(child, expected, 'mmap-path-after-old-descriptor-write')
    remove(repo, child)

    for arm in ARMS:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            # Allocate identifiers serially before starting subprocesses.
            futures = [pool.submit(create, repo, head, arm, f'concurrent-{i}') for i in range(2)]
            created = [f.result() for f in futures]
        for child, rec in created:
            if not rec['exit']:
                verify(child, expected, 'concurrent/' + arm)
                remove(repo, child)
    save()
    print('Completed:', args.output)
finally:
    save()
    log.close()
