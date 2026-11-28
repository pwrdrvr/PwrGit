import os,json,subprocess,hashlib,random,time,re,statistics,tarfile,io
from pathlib import Path
root=Path('/private/tmp/twig-scout-20261118');root.mkdir(exist_ok=False)
stock='/opt/homebrew/bin/git';pwr='/Applications/PwrGit.app/Contents/Resources/git/bin/git';twig='/private/tmp/git-twig-review-20261118/target/release/git-twig'
env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
env.update(GIT_CONFIG_GLOBAL=str(root/'config'),GIT_CONFIG_SYSTEM='/dev/null',GIT_CONFIG_NOSYSTEM='1',GIT_AUTHOR_NAME='Scout',GIT_COMMITTER_NAME='Scout',GIT_AUTHOR_EMAIL='scout@example.invalid',GIT_COMMITTER_EMAIL='scout@example.invalid',TWIG_TRACE='1',LC_ALL='C',PATH=str(Path(twig).parent)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')
(root/'config').write_text('[core]\n autocrlf=false\n hooksPath=/dev/null\n')
os.umask(0o022);log=(root/'commands.jsonl').open('w');results={'samples':[],'pins':{},'note':'Warm host APFS scout; no isolated volume allocation; shared host; LF attrs preserved. No comparisons with unreleased custom Git.'}
def run(cmd,cwd=None,timed=False,check=True):
 actual=['/usr/bin/time','-l',*map(str,cmd)] if timed else list(map(str,cmd))
 p=subprocess.run(actual,cwd=cwd,env=env,capture_output=True)
 entry=dict(command=actual,cwd=str(cwd),exit=p.returncode,stdout=('<archive>'+hashlib.sha256(p.stdout).hexdigest()) if 'archive' in actual else p.stdout.decode(errors='replace'),stderr=p.stderr.decode(errors='replace'))
 log.write(json.dumps(entry)+'\n');log.flush()
 if check and p.returncode:raise RuntimeError(entry)
 if timed:
  m=re.search(r'([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys',entry['stderr']);rss=re.search(r'(\d+)\s+maximum resident set size',entry['stderr']);p.metrics=dict(wall=float(m[1]),user=float(m[2]),system=float(m[3]),rss_bytes=int(rss[1]))
 return p
for b in [stock,pwr,twig]:results['pins'][b]=dict(version=run([b,'--version']).stdout.decode().strip(),sha256=hashlib.sha256(Path(b).read_bytes()).hexdigest())
for name,count,size in [('small',1000,1024),('bytes',32,4*1024**2)]:
 repo=root/name;run([stock,'init','-q','-b','main',repo]);(repo/'files').mkdir();rng=random.Random(608)
 (repo/'.gitattributes').write_text('* text=auto eol=lf\n')
 for i in range(count):(repo/'files'/str(i)).write_bytes(rng.randbytes(size))
 for p in repo.rglob('*'):
  if p.is_file() and '.git' not in p.parts:os.utime(p,(time.time()-20,time.time()-20))
 run([stock,'-C',repo,'add','.']);run([stock,'-C',repo,'commit','-qm','fixture'])
 archive=run([stock,'-C',repo,'archive','HEAD']).stdout
 with tarfile.open(fileobj=io.BytesIO(archive)) as tar:expected={m.name:hashlib.sha256(tar.extractfile(m).read()).hexdigest() for m in tar if m.isfile()}
 for b in [stock,pwr,twig]:Path(b).read_bytes()
 for i in range(6):
  arms=['stock','twig','on','off'] if i%2==0 else ['off','on','twig','stock']
  for arm in arms:
   target=root/(name+'-'+arm+'-'+str(i));cmd=[stock,'-C',repo,'twig','new','--detach',target,'HEAD'] if arm=='twig' else [pwr if arm in ['on','off'] else stock,*(['-c','checkout.reflink='+str(arm=='on').lower()] if arm in ['on','off'] else []),'-C',repo,'worktree','add','--detach',target,'HEAD']
   p=run(cmd,timed=True);status=run([stock,'-C',target,'status','--porcelain'],timed=True)
   bad=[n for n,h in expected.items() if hashlib.sha256((target/n).read_bytes()).hexdigest()!=h]
   entry=dict(fixture=name,round=i,arm=arm,create=p.metrics,status=status.metrics,status_output=status.stdout.decode(),mismatches=bad,trace=p.stderr.decode())
   if i==1:
    entry['probe']=run(['/private/tmp/pwrgit-twig-20261116/apfs-probe',repo/'files/0',target/'files/0']).stdout.decode()
   results['samples'].append(entry);(root/'results.json').write_text(json.dumps(results,indent=2))
   run([stock,'-C',repo,'worktree','remove','--force',target])
print(json.dumps({name:{a:statistics.median(x['create']['wall'] for x in results['samples'] if x['fixture']==name and x['arm']==a and x['round']>0) for a in ['stock','twig','on','off']} for name in ['small','bytes']}))
