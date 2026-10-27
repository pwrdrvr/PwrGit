#!/usr/bin/env python3
"""Disposable offline fixture. Invoke with the absolute pwrgit-share binary.
Prints measurements as JSON; never reads the operator's Cargo home. A single
local file:// Git dependency is cached with cargo fetch (no network source).
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time

binary = str(Path(sys.argv[1]).resolve())

def run(args, cwd, env, check=True):
    t = time.monotonic()
    p = subprocess.run([str(a) for a in args], cwd=cwd, env=env, capture_output=True, text=True)
    if check and p.returncode:
        raise RuntimeError(f"{args}: {p.stderr}")
    return p, round(time.monotonic() - t, 4)

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def snapshot(root):
    return {str(p.relative_to(root)): (p.stat().st_size, digest(p)) for p in root.rglob('*') if p.is_file() and not p.is_symlink()}

def added_bytes(before, after):
    return sum(v[0] for k, v in after.items() if k not in before)

def split(log):
    result = {"registryGit": {"Fresh": 0, "Compiling": 0}, "workspacePath": {"Fresh": 0, "Compiling": 0}}
    for action, name in re.findall(r'^\s*(Fresh|Compiling) ([^ ]+)', log, re.M):
        kind = "registryGit" if name in ("fixture-registry", "fixture-git") else "workspacePath"
        result[kind][action] += 1
    return result

with tempfile.TemporaryDirectory(prefix='pwrgit-share-benchmark-') as tmp:
    root = Path(tmp).resolve()
    donor, home, vendor, gitdep = (root / n for n in ('donor', 'cargo-home', 'vendor', 'gitdep'))
    donor.mkdir(); home.mkdir(); (vendor / 'fixture-registry/src').mkdir(parents=True); (gitdep / 'src').mkdir(parents=True)
    env = dict(os.environ, CARGO_HOME=str(home), CARGO_NET_OFFLINE='true', CARGO_TERM_COLOR='never')
    for key in ['CARGO_TARGET_DIR', 'CARGO_BUILD_TARGET_DIR', 'CARGO_BUILD_BUILD_DIR', 'RUSTFLAGS', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'PWRGIT_SHARE_FORCE_NONE']:
        env.pop(key, None)
    (home / 'config.toml').write_text(f'[source.crates-io]\nreplace-with="fixture"\n[source.fixture]\ndirectory={json.dumps(str(vendor))}\n')
    registry = vendor / 'fixture-registry'
    (registry / 'Cargo.toml').write_text('[package]\nname="fixture-registry"\nversion="1.0.0"\nedition="2021"\n[features]\nextra=[]\n')
    (registry / '.cargo-checksum.json').write_text('{"files":{},"package":null}')
    (registry / 'src/lib.rs').write_text('pub static TABLE: [u64; 262144] = [\n' + ''.join(f'{n * 2654435761},\n' for n in range(262144)) + '];\npub fn value()->u64 { TABLE[42] + u64::from(cfg!(feature="extra")) }\n')
    (gitdep / 'Cargo.toml').write_text('[package]\nname="fixture-git"\nversion="1.0.0"\nedition="2021"\n')
    (gitdep / 'src/lib.rs').write_text('pub fn value()->u64 { 7 }\n')
    def git(path, *args): return run(['git', *args], path, env)[0].stdout.strip()
    for repo in [gitdep, donor]:
        git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid')
    git(gitdep, 'add', '.'); git(gitdep, 'commit', '-m', 'local dependency')
    (donor / 'src').mkdir(); (donor / 'helper/src').mkdir(parents=True); (donor / 'path-only/src').mkdir(parents=True)
    (donor / 'Cargo.toml').write_text(f'''[workspace]
members=["helper"]
exclude=["path-only"]
[package]
name="fixture-workspace"
version="0.1.0"
edition="2021"
[dependencies]
fixture-registry="=1.0.0"
fixture-git={{git={json.dumps(gitdep.as_uri())}}}
fixture-helper={{path="helper"}}
fixture-path={{path="path-only"}}
[features]
extra=["fixture-registry/extra"]
''')
    for name, dirname in [('fixture-helper', 'helper'), ('fixture-path', 'path-only')]:
        (donor / dirname / 'Cargo.toml').write_text(f'[package]\nname="{name}"\nversion="0.1.0"\nedition="2021"\n')
        (donor / dirname / 'src/lib.rs').write_text('pub fn value()->u64 { 1 }\n')
    main = 'fn main() { println!("{}", fixture_registry::value()+fixture_git::value()+fixture_helper::value()+fixture_path::value()); }\n'
    (donor / 'src/main.rs').write_text(main); (donor / '.gitignore').write_text('target/\n')
    (donor / 'source-data.bin').write_bytes(bytes(range(256)) * 32768)
    # Cargo only fetches a local file:// repository. Registry source is vendored.
    run(['cargo', 'fetch'], donor, dict(env, CARGO_NET_OFFLINE='false'))
    git(donor, 'add', '.'); git(donor, 'commit', '-m', 'fixture')
    head = git(donor, 'rev-parse', 'HEAD')
    tracked = [Path(p) for p in git(donor, 'ls-files').splitlines()]
    tracked_bytes = sum((donor / p).stat().st_size for p in tracked)
    changed = main.replace('println!("{}"', 'println!("changed {}"')
    (donor / 'src/main.rs').write_text(changed); git(donor, 'add', '.'); git(donor, 'commit', '-m', 'changed source')
    changed_head = git(donor, 'rev-parse', 'HEAD'); git(donor, 'checkout', head)
    result = {"os": platform.platform(), "cargo": run(['cargo', '-V'], donor, env)[0].stdout.strip(), "rustc": run(['rustc', '-vV'], donor, env)[0].stdout.strip(), "rows": [], "sourceTrackedBytes": tracked_bytes}
    def cli(*args, extra_env=None):
        p, elapsed = run([binary, *args], donor, env if extra_env is None else dict(env, **extra_env))
        return json.loads(p.stdout), elapsed
    result['probe'], _ = cli('probe', '--json', root)
    def measure(path): return cli('measure', '--json', path)[0]
    def source(name, plain=False, none=False, seed=False):
        dest = root / name
        before = shutil.disk_usage(root).free
        if plain:
            _, elapsed = run(['git', 'worktree', 'add', '-b', name, dest, head], donor, env); report = {"clonedFiles": 0, "fallback": "git-checkout"}
        else:
            args = ['worktree', 'add', '--json', '-b', name]
            if seed: args += ['--seed-target']
            report, elapsed = cli(*args, dest, head, extra_env={'PWRGIT_SHARE_FORCE_NONE': '1'} if none else None)
        delta = before - shutil.disk_usage(root).free
        assert git(dest, 'rev-parse', 'HEAD') == head
        assert not git(dest, 'status', '--porcelain')
        assert all((donor / p).read_bytes() == (dest / p).read_bytes() for p in tracked)
        result['rows'].append({"run": name, "seconds": elapsed, "report": report, "measure": measure(dest), "freeSpaceDeltaBytesNoisy": delta})
        return dest, report
    plain, _ = source('source-plain', plain=True)
    source('source-reflink'); source('source-forced-none', none=True)
    def build(path, args=(), extra=None, target=None):
        e = dict(env, **(extra or {}))
        if target: e['CARGO_TARGET_DIR'] = str(target)
        p, elapsed = run(['cargo', 'build', '--offline', '-v', *args], path, e)
        return {"seconds": elapsed, "counts": split(p.stderr), "log": p.stderr, "exitCode": p.returncode}
    cold = build(donor); cold['run'] = 'cold-donor'; result['rows'].append(cold)
    result['donorTargetMeasure'] = measure(donor / 'target')
    seeded, seed_report = source('seeded', seed=True)
    hidden = root / 'donor-hidden-target'; (donor / 'target').rename(hidden)
    first = build(seeded); first.update(run='same-commit', measure=measure(seeded / 'target')); result['rows'].append(first)
    assert seed_report['target']['unitsSeeded'] == 0
    assert seed_report['target']['reason'] == 'fingerprint-unproven'
    assert first['counts']['registryGit']['Fresh'] == 0, first
    assert first['counts']['registryGit']['Compiling'] == 2
    assert first['counts']['workspacePath']['Compiling'] == 3
    expected = str(42 * 2654435761 + 9)
    assert run([seeded / 'target/debug/fixture-workspace'], seeded, env)[0].stdout.strip() == expected
    before = snapshot(seeded / 'target'); (seeded / 'src/main.rs').write_text(changed)
    row = build(seeded); after = snapshot(seeded / 'target'); row.update(run='changed-source', newFileBytes=added_bytes(before, after)); result['rows'].append(row)
    assert row['counts']['registryGit']['Fresh'] == 2
    assert run([seeded / 'target/debug/fixture-workspace'], seeded, env)[0].stdout.strip() == 'changed ' + expected
    before = after
    row = build(seeded, extra={'RUSTFLAGS': '--cfg pwrgit_share_probe'}); after = snapshot(seeded / 'target'); row.update(run='changed-rustflags', newFileBytes=added_bytes(before, after), unusedSeededBytes=0); result['rows'].append(row)
    before = after
    row = build(seeded, args=['--features', 'extra']); after = snapshot(seeded / 'target'); row.update(run='changed-features', newFileBytes=added_bytes(before, after)); result['rows'].append(row)
    assert row['counts']['registryGit']['Compiling'] == 1
    assert run([seeded / 'target/debug/fixture-workspace'], seeded, env)[0].stdout.strip() == 'changed ' + str(int(expected)+1)
    row = build(seeded, args=['--release']); row.update(run='second-profile', measure=measure(seeded / 'target/release')); result['rows'].append(row)
    git(seeded, 'reset', '--hard', head); git(seeded, 'checkout', changed_head)
    row = build(seeded); row['run'] = 'branch-switch'; result['rows'].append(row)
    # Restore donor only to create two more seeds, then hide it for both builds.
    hidden.rename(donor / 'target')
    a, _ = source('concurrent-a', seed=True); b, _ = source('concurrent-b', seed=True)
    (donor / 'target').rename(hidden)
    samples = [next((hidden / 'debug/deps').glob('libfixture_registry-*.rlib'))]
    hashes = [digest(p) for p in samples]
    start = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        future_a = pool.submit(build, a)
        future_b = pool.submit(build, b, ['--features', 'extra'])
        builds = [future_a.result(), future_b.result()]
    assert [digest(p) for p in samples] == hashes
    result['rows'].append({'run': 'concurrent-private-targets', 'seconds': round(time.monotonic()-start,4), 'builds': builds, 'donorRlibHashesUnchanged': True, 'seededRlibHashesUnchanged': None, 'unitsSeeded': 0})
    assert run([a / 'target/debug/fixture-workspace'], a, env)[0].stdout.strip() == expected
    assert run([b / 'target/debug/fixture-workspace'], b, env)[0].stdout.strip() == str(int(expected)+1)
    shared = root / 'shared-baseline-target'; start = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        future_a = pool.submit(build, a, (), None, shared)
        future_b = pool.submit(build, b, ['--features', 'extra'], None, shared)
        shared_builds = [future_a.result(), future_b.result()]
    result['rows'].append({'run': 'shared-target-baseline', 'seconds': round(time.monotonic()-start,4), 'builds': shared_builds, 'lockWaitObserved': any('Blocking waiting for file lock' in x['log'] for x in shared_builds)})
    a_source = digest(donor / 'source-data.bin'); (a / 'source-data.bin').write_bytes(b'edit'); assert digest(donor / 'source-data.bin') == a_source
    git(a, 'reset', '--hard', head); assert digest(donor / 'source-data.bin') == a_source
    assert all(p.stat().st_nlink == 1 for tree in [a, b] for p in tree.rglob('*') if p.is_file() and not p.is_symlink() and ('target' not in p.relative_to(tree).parts or '.fingerprint' in p.parts))
    result['isolation'] = 'edit/reset and concurrent build outputs verified; source and fingerprint nlink=1 (Cargo own uplifted output links excluded)'
    result['finalTargets'] = {name: measure(path / 'target') for name,path in [('seeded',seeded),('a',a),('b',b)]}
    print(json.dumps(result, indent=2))
