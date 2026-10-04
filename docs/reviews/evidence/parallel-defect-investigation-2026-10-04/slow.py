import sys,time
n=0
while True:
    b=sys.stdin.buffer.read(4096)
    if not b: break
    n+=len(b); time.sleep(0.02)
print(n)
