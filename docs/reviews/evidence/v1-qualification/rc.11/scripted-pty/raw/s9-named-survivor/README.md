# RC11 s9 named-survivor reruns

Three retained executions of `s9_named_survivor.py` against the installed RC11 scripted-PTY environment. Each run observed the synthetic `sleep 23.7` child before quit, then observed TUI exit and no remaining matching child after the second Ctrl-C. The probe aborts before starting if a pre-existing matching process makes the check ambiguous.

The probe imports the shared `raw/ptylib.py` and `raw/mockgw.py`; their source hashes are respectively `6fa0a982ae4eb255845f8927d4924d0fbb0c305e8b4782e03272bb636364cf3f` and `fa31ba6583998cafc4c60dfa65c611bd43d2ebf8d03a61798935811652a47e7d`. `SOURCE-SHA256SUMS` is the original source inventory for the three logs, probe, and those shared harness files. This evidence does not imply the original overall runner exit code was retained.
