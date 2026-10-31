#!/usr/bin/env python3
import json, os, pathlib, select, subprocess, tempfile, time

binary = pathlib.Path('/tmp/nexus-rc14-pty.wHTfre/prefix/lib/nexus/v1.0.0-rc.14/lib/core/harness-core')
root = pathlib.Path(__file__).resolve().parent
workspace = root / 'workspace'
workspace.mkdir(exist_ok=True)
home = pathlib.Path(tempfile.mkdtemp(prefix='nexus-rc14-rpc-cancel-home-'))
(home / '.config').mkdir()
env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / '.config'))
p = subprocess.Popen([str(binary), '--workspace', str(workspace), 'rpc'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
result = {'artifact': str(binary), 'workspace': str(workspace), 'command': 'sleep 20; echo finished', 'responses': [], 'processesAtCancel': [], 'processesAfterCancel': []}

def snapshot():
    rows = subprocess.check_output(['ps', '-eo', 'pid=,ppid=,pgid=,stat=,args='], text=True).splitlines()
    return [line.strip() for line in rows if 'sleep 20' in line or ('bash -c sleep 20' in line)]

try:
    p.stdin.write(json.dumps({'id': 41, 'method': 'run_command', 'params': {'command': result['command'], 'timeout_secs': 30}}) + '\n')
    p.stdin.flush()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result['processesAtCancel'] = snapshot()
        if any('sleep 20' in row for row in result['processesAtCancel']):
            break
        time.sleep(0.02)
    result['cancelSentAfterProcessObserved'] = any('sleep 20' in row for row in result['processesAtCancel'])
    p.stdin.write(json.dumps({'id': 42, 'method': 'cancel', 'params': {'request_id': 41}}) + '\n')
    p.stdin.flush()
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and len(result['responses']) < 2:
        ready, _, _ = select.select([p.stdout], [], [], 0.2)
        if ready:
            line = p.stdout.readline()
            if line:
                result['responses'].append(json.loads(line))
    result['processesAfterCancel'] = snapshot()
    result['cancelProbePass'] = result['cancelSentAfterProcessObserved'] and len(result['responses']) == 2 and any(x.get('id') == 42 and x.get('result', {}).get('cancelled') is True for x in result['responses']) and any(x.get('id') == 41 and x.get('result', {}).get('cancelled') is True for x in result['responses']) and not result['processesAfterCancel']
finally:
    try:
        p.stdin.close()
    except Exception:
        pass
    try:
        p.wait(timeout=4)
    except subprocess.TimeoutExpired:
        p.terminate()
        p.wait(timeout=3)
    result['engineExitCode'] = p.returncode
    (root / 'rpc-cancel-status.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
