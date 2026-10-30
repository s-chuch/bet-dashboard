import os,sys,json,subprocess,shutil,tempfile
src=os.path.dirname(os.path.dirname(os.path.abspath(__file__))); d=tempfile.mkdtemp(); shutil.copytree(src,d+'/r',ignore=shutil.ignore_patterns('.git'))
r=d+'/r'
sk=r+'/data/finder_skips.csv'; hdr=open(sk).readline(); open(sk,'w').write(hdr)   # start empty: the copied real file may already hold today's skips
bets=[{"date":__import__("datetime").date.today().isoformat(),"book":"theScore","event":"Detroit Pistons @ Miami Heat","start_et":"Fri Oct 23, 8:00 PM ET","market":"Moneyline (50% profit boost)","pick":"Detroit Pistons ML","price":"+114","boosted_price":"+171","stake":"1.00","to_win":"1.71","placed_at":"2026-10-22 19:10","kind":"boost","sport":"NBA","game_start":"2026-10-23 20:00","selection":"Detroit Pistons to win","fair":"49.77","rec_price":"+114","key":"2026-10-24|Detroit Pistons @ Miami Heat|Detroit Pistons to win"},
{"skip":"1","book":"theScore","event":"Borussia Moenchengladbach @ VfB Stuttgart","price":"+475","key":"2026-10-23|Borussia Moenchengladbach @ VfB Stuttgart|Draw","reason":"","kind":"bonus","sport":"SOCCER","selection":"Draw","game_start":"2026-10-23 14:30"}]
env=dict(os.environ,BETS_JSON=json.dumps(bets))
p=subprocess.run([sys.executable,'scripts/add_bets.py'],cwd=r,env=env,capture_output=True,text=True);assert p.returncode==0 and 'rec added for finder pick' in p.stdout and 'skipped: theScore' in p.stdout, p.stdout+p.stderr
p=subprocess.run([sys.executable,'scripts/add_bets.py'],cwd=r,env=env,capture_output=True,text=True);assert 'skipped duplicate' in p.stdout and 'skip already recorded' in p.stdout, p.stdout
assert 'Draw' in open(r+'/data/finder_skips.csv').read()
assert 'SKIPPED in Bet Finder' in open(r+'/data/recommendations.csv').read()
p=subprocess.run([sys.executable,'-c','import sys;sys.path.insert(0,"scripts");import ev_scan as E,datetime as dt;print(len(E.skipped_today(".",dt.datetime.now(E.ET))))'],cwd=r,capture_output=True,text=True)
assert p.stdout.strip()=='1', p.stdout+p.stderr
shutil.rmtree(d); print('finder log/skip: all passed')
