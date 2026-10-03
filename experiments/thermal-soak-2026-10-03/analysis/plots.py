#!/usr/bin/env python3
"""Plots for the soak (needs matplotlib: pip install matplotlib). Writes PNGs to ./plots/."""
import json, os, statistics as st, sys
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
HERE = os.path.dirname(os.path.abspath(__file__)); RAW = os.path.join(HERE, "..", "raw", "thermal-soak-20261003T170044Z"); OUT = os.path.join(HERE, "plots"); os.makedirs(OUT, exist_ok=True)
rows = [json.loads(l) for l in open(RAW + "/samples.jsonl")]; reqs = [json.loads(l) for l in open(RAW + "/requests.jsonl")]
BDF = sorted(rows[0]["gpu"]); T = [r["t"] / 60 for r in rows]
PH = [("baseline", 0, 120, "#eeeeee"), ("decode", 120, 1440, "#fff1d6"), ("prefill", 1440, 2761, "#dcebfa"), ("cooldown", 2761, 3245, "#eeeeee")]
def shade(ax):
    for n, a, b, c in PH: ax.axvspan(a / 60, b / 60, color=c, zorder=0); ax.text((a + b) / 120, ax.get_ylim()[1], n, ha="center", va="top", fontsize=8, color="#555")
def temp(b, k): return [r["gpu"][b]["temps"][k] for r in rows]
fig, axs = plt.subplots(2, 1, figsize=(12, 9), sharex=True)
for ax, b, title in zip(axs, BDF, ("GPU 0 (lead, Qwen3-Coder-30B-A3B)", "GPU 1 (deep, Qwen3.5-27B)")):
    chans = [k for k in rows[0]["gpu"][b]["temps"] if k.startswith("vram_ch")]
    ax.plot(T, [st.median(r["gpu"][b]["temps"][k] for k in chans) for r in rows], label="VRAM median channel", color="#8bbf8b", lw=1)
    ax.plot(T, temp(b, "vram"), label="VRAM (hottest channel)", color="#c0392b", lw=1.2); ax.plot(T, temp(b, "pkg"), label="package", color="#2c3e50", lw=1.2)
    ax.plot(T, temp(b, "pcie"), label="PCIe", color="#7f8c8d", lw=0.9); ax.plot(T, temp(b, "mctrl"), label="memory controller", color="#2e86c1", lw=0.9)
    for y, lab in ((75, "75 current warn"), (85, "85 current crit"), (90, "90 benchmark abort")): ax.axhline(y, color="#999", ls="--", lw=0.8); ax.text(0.2, y + 0.5, lab, fontsize=7, color="#777")
    ax.set_ylim(15, 100); ax.set_ylabel("deg C"); ax.set_title(title); ax.legend(loc="center right", fontsize=8, ncol=2); shade(ax)
axs[1].set_xlabel("minutes"); fig.suptitle("Sustained inference soak: per-sensor temperatures (reference lines are the CURRENT policy, not recommendations)"); fig.tight_layout(); fig.savefig(OUT + "/temperatures.png", dpi=110); plt.close(fig)
fig, axs = plt.subplots(3, 1, figsize=(12, 9), sharex=True)
for b, name, col in zip(BDF, ("GPU 0", "GPU 1"), ("#2c3e50", "#c0392b")):
    p = [None] + [(rows[i]["gpu"][b]["energy_uj"]["card"] - rows[i - 1]["gpu"][b]["energy_uj"]["card"]) / 1e6 / (rows[i]["t"] - rows[i - 1]["t"]) for i in range(1, len(rows))]
    axs[0].plot(T[1:], p[1:], label=name, color=col, lw=0.7)
    axs[1].plot(T, [r["gpu"][b]["gt"]["gt0"]["act_mhz"] for r in rows], label=name, color=col, lw=0.7)
    axs[2].plot(T, [r["gpu"][b]["fan_rpm"] for r in rows], label=name + " fan", color=col, lw=0.9)
axs[0].axhline(200, color="#999", ls="--", lw=0.8); axs[0].text(0.2, 202, "200 W card PL2 limit", fontsize=7); axs[0].set_ylabel("card power (W)"); axs[1].set_ylabel("actual freq (MHz)"); axs[2].set_ylabel("GPU fan (rpm)")
g1 = BDF[1]
for ax in axs:
    ax.legend(loc="center right", fontsize=8); shade(ax)
axs[2].set_xlabel("minutes"); fig.suptitle("Power, frequency and fan response (GPU 1 raised PL2 in 94% of loaded samples; no thermal flag ever)"); fig.tight_layout(); fig.savefig(OUT + "/power_freq_fans.png", dpi=110); plt.close(fig)
fig, axs = plt.subplots(1, 2, figsize=(12, 4.2))
for model, col in (("engineering/lead", "#2c3e50"), ("engineering/deep", "#c0392b")):
    d = [q for q in reqs if q["kind"] == "decode" and q["model"] == model and q["status"] == 200]; axs[0].plot([q["t_end"] / 60 for q in d], [q["completion_tokens"] / q["secs"] for q in d], ".", color=col, label=model.split("/")[1])
    p = [q for q in reqs if q["kind"] == "prefill" and q["model"] == model and q["status"] == 200]; axs[1].plot([q["t_end"] / 60 for q in p], [q["prompt_tokens"] / q["secs"] for q in p], ".", color=col, label=model.split("/")[1])
axs[0].set_title("decode phase: tokens/s per request"); axs[1].set_title("prefill phase: prompt tokens/s per request")
for ax in axs: ax.set_xlabel("minutes"); ax.legend(); ax.grid(alpha=.3)
fig.tight_layout(); fig.savefig(OUT + "/throughput.png", dpi=110); plt.close(fig)
print("wrote", sorted(os.listdir(OUT)))
