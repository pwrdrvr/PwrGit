#!/usr/bin/env python3
"""Summarize saved JSON/JSON.gz without rerunning any benchmark."""
import argparse
from collections import Counter
import gzip
import json
from pathlib import Path
import statistics

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('inputs', type=Path, nargs='+')
a = p.parse_args()


def porcelain(text):
    summary = text.split('\0summary\0')[-1]
    return {k: int(v) if v.isdigit() else v for k, v in
            (field.split(' ', 1) for field in summary.split('\0') if ' ' in field)}


out = {}
for path in a.inputs:
    with (gzip.open(path, 'rt') if path.suffix == '.gz' else path.open()) as f:
        d = json.load(f)
    if 'timings' not in d:
        continue
    result = dict(timing=[], allocation=d['allocation'],
                  incorrect_trees=[x for x in d['checks'] if x['mismatches']],
                  nonzero_creates=[x for x in d['timings'] if x['exit']],
                  checks=len(d['checks']), resets=len(d.get('reset_checks', [])),
                  reshare=[], sharing=[], concurrent=[])
    for fixture in sorted({x['fixture'] for x in d['timings']}):
        for rev in ['head', 'older']:
            for arm in ['stock', 'twig', 'on', 'off']:
                rows = [x for x in d['timings'] if x['fixture'] == fixture and x['arm'] == arm
                        and x['label'] in [f'{rev}-{i}' for i in range(1, 6)]]
                if not rows:
                    continue
                result['timing'].append(dict(fixture=fixture, rev=rev, arm=arm,
                    samples={k: [x['metrics'][k] for x in rows] for k in rows[0]['metrics']},
                    median={k: statistics.median(x['metrics'][k] for x in rows) for k in rows[0]['metrics']},
                    backends=dict(Counter(x['backend'] for x in rows)),
                    sharing=rows[0].get('sharing')))
    for op in d['operations']:
        if 'apply' in op:
            result['reshare'].append({k: v for k, v in op.items() if k not in ('dry', 'apply')} |
                                     dict(dry=porcelain(op['dry']), apply=porcelain(op['apply'])))
        elif 'sharing' in op:
            result['sharing'].append(op)
        elif 'mmap' in op['label']:
            result.setdefault('mmap', []).append(op)
    result['concurrent'] = [{k: v for k, v in row.items() if k != 'sharing'}
                            for row in d['timings'] if row['label'].startswith('concurrent-')]
    out[str(path)] = result
print(json.dumps(out, indent=2))
