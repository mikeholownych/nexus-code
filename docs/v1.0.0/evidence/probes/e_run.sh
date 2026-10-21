#!/bin/bash
# usage: e_run.sh HOME cmd...
H=$1; shift
exec env -i HOME="$H" PATH="$H/.local/bin:/usr/bin:/bin" TERM=dumb "$@"
