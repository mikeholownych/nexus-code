import os, pathlib, subprocess, sys, time
root=pathlib.Path(__file__).parent
home=root/'outer-home'
for p in (home, home/'.config', home/'.local/share', home/'.local/state', home/'.cache'):
    p.mkdir(parents=True,exist_ok=True)
env=dict(os.environ)
env.update({
  'HOME':str(home),
  'XDG_CONFIG_HOME':str(home/'.config'),
  'XDG_DATA_HOME':str(home/'.local/share'),
  'XDG_STATE_HOME':str(home/'.local/state'),
  'XDG_CACHE_HOME':str(home/'.cache'),
  'PATH':'/home/mike/.local/node-v24.11.1-linux-x64/bin:/usr/local/bin:/usr/bin:/bin',
  'TERM':'xterm-256color',
  'LANG':'C.UTF-8',
})
python='/var/tmp/nexus-rc10-scripted-pty-staging-20261027T0110Z/venv/bin/python'
cases=[
 's1_startup.py','s2_approval.py','s3_complete.py','s4_cancel.py','s5_ctrlc.py',
 's6_steer_apply_rc9.py','s7_resume.py','s8_cancel_tool.py','s9_quit_tool.py',
 'r1a_rc9.py','r1d_rc9.py','cancel_measurement_rc9.py'
]
results=[]
for name in cases:
  log=root/(name+'.log')
  print('START',name,time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),flush=True)
  with log.open('wb') as out:
    try:
      p=subprocess.run([python,str(root/name)],cwd=root,env=env,stdout=out,stderr=subprocess.STDOUT)
      rc=p.returncode
    except Exception as e:
      out.write((repr(e)+'\n').encode())
      rc=255
  results.append((name,rc))
  print('RESULT',name,'PASS' if rc==0 else f'FAIL rc={rc}',flush=True)
print('SUMMARY',results,flush=True)
sys.exit(0 if all(rc==0 for _,rc in results) else 1)
