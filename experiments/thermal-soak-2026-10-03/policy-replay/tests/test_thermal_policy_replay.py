"""Deterministic tests for the offline thermal-policy replay. Every synthetic trace is 1 Hz (sample i is at t = i seconds) and the
expected result is derived by inspection in the comment above each assertion. Run: python -m unittest discover -s tests -v"""
import copy, hashlib, json, os, shutil, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, ".."))
import thermal_policy_replay as tpr
RAW = os.path.join(HERE, "..", "..", "raw", "thermal-soak-20261003T170044Z")


def one(values, cls_key="pkg", **rule):
    """Replay a single rule on one synthetic series; returns (rule_result, combined_gpu0)."""
    trace = tpr.Trace.synthetic({"gpu0": {cls_key: values}})
    cls = {"pkg": "package", "vram": "vram", "pcie": "pcie", "mctrl": "memory_controller"}[cls_key]
    base = {"id": "r", "sensor_class": cls, "state": "warning", "threshold_c": 75}; base.update(rule)
    res = tpr.replay(trace, tpr.parse_policy({"name": "t", "status": "illustrative_example", "rules": [base]}))
    return res["rules"][0], res["combined"]["gpu0"], res


def acts(rr): return [e["activated_index"] for e in rr["episodes"]]
def clears(rr): return [e["cleared_index"] for e in rr["episodes"]]


class ThresholdCrossing(unittest.TestCase):
    def test_instantaneous_inclusive_threshold(self):
        # values 70,74,75,76,74,75 with threshold 75 (>=): activate at idx2 (75), clear at idx4 (74<75), re-activate at idx5 (75).
        rr, _, _ = one([70, 74, 75, 76, 74, 75])
        self.assertEqual(acts(rr), [2, 5]); self.assertEqual(clears(rr), [4, None])
        self.assertEqual((rr["trips"], rr["re_trips"], rr["transitions"]), (2, 1, 3))   # 2 activations + 1 clear
        self.assertEqual(rr["active_seconds"], 2 + 1)                                       # idx2,3 active (2 s) + idx5 (1 s, still open)
        self.assertEqual((rr["first_activation_t"], rr["last_activation_t"], rr["last_clear_t"]), (2, 5, 4)); self.assertTrue(rr["open_at_end_of_trace"])

    def test_never_reaching_threshold_produces_no_trip(self):
        rr, comb, _ = one([60, 70, 74.9, 74])
        self.assertEqual((rr["trips"], rr["transitions"], rr["active_seconds"]), (0, 0, 0)); self.assertEqual(comb["transition_count"], 0)


class Persistence(unittest.TestCase):
    def test_run_must_reach_persistence_length(self):
        # persistence 3, values 76,76,74,76,76,76,76,70: first run is 2 long (no trip); second run starts idx3 and reaches 3 at idx5 -> activate idx5;
        # clears at idx7 (70<75). The episode reports the condition began at idx3.
        rr, _, _ = one([76, 76, 74, 76, 76, 76, 76, 70], persistence_s=3)
        self.assertEqual(acts(rr), [5]); self.assertEqual(clears(rr), [7])
        e = rr["episodes"][0]; self.assertEqual((e["condition_started_index"], e["activated_to_condition_start_latency_s"]), (3, 2))
        self.assertEqual([s["sample_index"] for s in e["condition_run"]["samples"]], [3, 4, 5])
        self.assertEqual(rr["active_seconds"], 2)                                            # idx5,6 active

    def test_persistence_of_one_second_is_instantaneous(self):
        a, _, _ = one([70, 80, 70], persistence_s=1); b, _, _ = one([70, 80, 70], persistence_s=0)
        self.assertEqual((acts(a), acts(b)), ([1], [1]))


class Hysteresis(unittest.TestCase):
    VALS = [76, 74, 73, 71, 76]
    def test_without_hysteresis_clears_as_soon_as_below_threshold(self):
        # threshold 75, no hysteresis: activate idx0; idx1 (74<75) clears; idx4 (76) re-activates.
        rr, _, _ = one(self.VALS); self.assertEqual((acts(rr), clears(rr)), ([0, 4], [1, None]))
    def test_hysteresis_holds_the_state_inside_the_band(self):
        # hysteresis 3 -> clear level 72: 74 and 73 stay active, 71 (<72) clears at idx3, idx4 re-activates.
        rr, _, _ = one(self.VALS, hysteresis_c=3); self.assertEqual((acts(rr), clears(rr)), ([0, 4], [3, None]))
    def test_clear_level_is_strict(self):
        # value exactly at the clear level (72) does NOT clear (needs < 72).
        rr, _, _ = one([76, 72, 72, 71], hysteresis_c=3); self.assertEqual(clears(rr), [3])
    def test_clear_persistence_needs_consecutive_low_samples(self):
        # clear persistence 2: 76,70,76,70,70,76 -> a lone low sample (idx1) is forgotten by 76 at idx2; idx3,4 are two in a row -> clear at idx4; re-activate idx5.
        rr, _, _ = one([76, 70, 76, 70, 70, 76], clear_persistence_s=2); self.assertEqual((acts(rr), clears(rr)), ([0, 5], [4, None]))


class SingleSampleExcursion(unittest.TestCase):
    def test_instantaneous_trips_once_persistent_ignores_it(self):
        v = [70, 70, 80, 70, 70]
        rr, _, _ = one(v); self.assertEqual((rr["trips"], rr["active_seconds"], rr["short_episodes"], rr["longest_episode_s"]), (1, 1, 1, 1))
        rr2, comb, _ = one(v, persistence_s=2); self.assertEqual((rr2["trips"], comb["transition_count"], rr2["active_seconds"]), (0, 0, 0))


class Oscillation(unittest.TestCase):
    V = [74, 76] * 5                     # 74,76,74,76,... idx1,3,5,7,9 are at/above 75
    def test_instantaneous_flaps_every_cycle(self):
        # activations at idx1,3,5,7,9; clears at idx2,4,6,8 (idx9 still open): 5 trips, 4 re-trips, 9 transitions, five 1-second episodes.
        rr, comb, _ = one(self.V); self.assertEqual((acts(rr), clears(rr)), ([1, 3, 5, 7, 9], [2, 4, 6, 8, None])); self.assertEqual((rr["trips"], rr["re_trips"], rr["transitions"], rr["short_episodes"]), (5, 4, 9, 5))
        self.assertEqual(comb["flaps"], 4)   # ok->warning then warning->ok within 60 s: pairs (1,2),(3,4),(5,6),(7,8)
    def test_persistence_removes_the_oscillation(self):
        rr, _, _ = one(self.V, persistence_s=2); self.assertEqual(rr["trips"], 0)          # never two at/above in a row
    def test_hysteresis_turns_it_into_one_episode(self):
        # hysteresis 2 -> clear level 73: 74 is never below it, so after activating at idx1 the state never clears.
        rr, _, _ = one(self.V, hysteresis_c=2); self.assertEqual((rr["trips"], clears(rr), rr["active_seconds"]), (1, [None], 9))


class MissingSamples(unittest.TestCase):
    V = [76, None, 76, 76]
    def go(self, policy, values=None, persistence=3, **kw):
        return one(values or self.V, persistence_s=persistence, missing=policy, **kw)[0]
    def test_hold_ignores_the_gap(self):
        # persistence 3, hold: counts idx0 (1), idx1 missing (unchanged), idx2 (2), idx3 (3) -> activate idx3.
        self.assertEqual(acts(self.go("hold")), [3])
    def test_clear_treats_the_gap_as_not_above(self):
        # clear: idx0 (1), idx1 resets, idx2 (1), idx3 (2) -> never reaches 3.
        self.assertEqual(self.go("clear")["trips"], 0)
    def test_fail_closed_treats_the_gap_as_above(self):
        # fail_closed: idx0 (1), idx1 missing counts (2), idx2 (3) -> activate idx2 (earlier than hold).
        rr = self.go("fail_closed"); self.assertEqual(acts(rr), [2]); self.assertIsNone(rr["episodes"][0]["condition_run"]["samples"][1]["value"])
    def test_gap_while_active(self):
        v = [80, None, None, 80]
        self.assertEqual(self.go("hold", v, 1)["transitions"], 1)                          # stays active, never clears
        rr = self.go("clear", v, 1); self.assertEqual((acts(rr), clears(rr)), ([0, 3], [1, None]))   # idx0 activates, the first missing sample clears it, idx3 re-activates
        self.assertEqual(self.go("fail_closed", v, 1)["transitions"], 1)                  # missing never clears
    def test_missing_pool_for_composite_class(self):
        tr = tpr.Trace.synthetic({"gpu0": {"vram_ch_0": [70, None], "vram_ch_1": [72, None]}})
        ser = tpr.class_series(tr, "gpu0", "vram_hottest_channel"); self.assertEqual([s[0] for s in ser], [72, None])


class SensorClasses(unittest.TestCase):
    def test_vram_hottest_channel_is_the_max_not_an_average_and_names_its_source(self):
        t = {"vram_ch_0": 70, "vram_ch_1": 76, "vram_ch_2": 72, "pkg": 66, "vram": 76, "mctrl": 49, "pcie": 67}
        v, src, cov = tpr.class_value(t, "vram_hottest_channel"); self.assertEqual((v, src, cov), (76, "vram_ch_1", ""))
        self.assertNotEqual(v, sum([70, 76, 72]) / 3)
        self.assertEqual(tpr.class_value(t, "package")[0], 66); self.assertEqual(tpr.class_value(t, "vram")[0], 76)
        self.assertEqual(tpr.class_value(t, "any_sensor")[:2], (76, "vram"))                 # 'vram' and 'vram_ch_1' tie at 76: the first label in sorted order wins
    def test_partial_channel_loss_is_reported_not_hidden(self):
        v, src, cov = tpr.class_value({"vram_ch_0": 70, "vram_ch_1": None, "vram_ch_2": 74}, "vram_hottest_channel"); self.assertEqual((v, src, cov), (74, "vram_ch_2", "2/3"))
    def test_package_and_vram_rules_are_independent(self):
        tr = tpr.Trace.synthetic({"gpu0": {"pkg": [66] * 6, "vram": [70, 70, 80, 80, 80, 70]}})
        pol = tpr.parse_policy({"name": "split", "status": "illustrative_example", "rules": [
            {"id": "pkg", "sensor_class": "package", "state": "warning", "threshold_c": 70}, {"id": "vram", "sensor_class": "vram", "state": "warning", "threshold_c": 75}]})
        r = {x["rule"]["id"]: x for x in tpr.replay(tr, pol)["rules"]}; self.assertEqual((r["pkg"]["trips"], r["vram"]["trips"], r["vram"]["active_seconds"]), (0, 1, 3))


class CombinedState(unittest.TestCase):
    def test_escalation_and_de_escalation_sequence(self):
        # warning>=75, critical>=85 instantaneous; values 70,76,86,80,70:
        # idx1 ok->warning; idx2 warning->critical; idx3 critical->warning (86->80, critical cleared, warning still active); idx4 warning->ok.
        tr = tpr.Trace.synthetic({"gpu0": {"pkg": [70, 76, 86, 80, 70]}})
        pol = tpr.parse_policy({"name": "ladder", "status": "illustrative_example", "rules": [
            {"id": "w", "sensor_class": "package", "state": "warning", "threshold_c": 75}, {"id": "c", "sensor_class": "package", "state": "critical", "threshold_c": 85}]})
        comb = tpr.replay(tr, pol)["combined"]["gpu0"]
        self.assertEqual([(x["sample_index"], x["from"], x["to"]) for x in comb["transitions"]], [(1, "ok", "warning"), (2, "warning", "critical"), (3, "critical", "warning"), (4, "warning", "ok")])
        self.assertEqual(comb["time_in_state_s"], {"ok": 2, "warning": 2, "critical": 1, "abort": 0})
        self.assertEqual((comb["first_transition_t"], comb["last_transition_t"], comb["flaps"]), (1, 4, 1))      # one flap: the escalation at idx2 followed within 60 s by the de-escalation at idx3
    def test_transitions_carry_the_raw_observation_that_caused_them(self):
        tr = tpr.Trace.synthetic({"gpu0": {"pkg": [70, 76, 86, 80, 70]}})
        pol = tpr.parse_policy({"name": "ladder", "status": "illustrative_example", "rules": [{"id": "c", "sensor_class": "package", "state": "critical", "threshold_c": 85}]})
        tx = tpr.replay(tr, pol)["combined"]["gpu0"]["transitions"][0]
        o = tx["raw_observations"][0]; self.assertEqual((tx["raw_line"], o["event"], o["value"], o["source"], o["raw_line"]), (3, "activated", 86, "pkg", 3))
    def test_system_state_is_the_worst_gpu(self):
        tr = tpr.Trace.synthetic({"gpu0": {"pkg": [70, 70, 70]}, "gpu1": {"pkg": [70, 90, 70]}})
        pol = tpr.parse_policy({"name": "sys", "status": "illustrative_example", "rules": [{"id": "a", "sensor_class": "package", "state": "abort", "threshold_c": 90}]})
        c = tpr.replay(tr, pol)["combined"]; self.assertEqual((c["gpu0"]["transition_count"], c["gpu1"]["transition_count"], c["system"]["time_in_state_s"]["abort"]), (0, 2, 1))
    def test_time_in_state_accounts_for_every_sample(self):
        _, comb, _ = one([70, 80, 80, 70, 80]); self.assertEqual(sum(comb["time_in_state_s"].values()), 5)


class PolicyValidation(unittest.TestCase):
    def good(self): return {"name": "x", "status": "illustrative_example", "rules": [{"id": "a", "sensor_class": "package", "state": "warning", "threshold_c": 75}]}
    def test_unlabeled_or_bad_policies_are_rejected(self):
        for mutate in (lambda d: d.pop("status"), lambda d: d.update(status="recommended"), lambda d: d["rules"][0].update(sensor_class="gpu"), lambda d: d["rules"][0].update(state="ok"),
                       lambda d: d["rules"][0].update(missing="guess"), lambda d: d["rules"][0].update(persistence_s=-1), lambda d: d["rules"][0].update(threshold_c=float("nan")), lambda d: d["rules"][0].update(id="a:b"),
                       lambda d: d["rules"].append(copy.deepcopy(d["rules"][0])), lambda d: d["rules"][0].update(gpus=[]), lambda d: d["rules"][0].pop("threshold_c")):
            d = self.good(); mutate(d)
            with self.assertRaises(tpr.PolicyError): tpr.parse_policy(d)
        tpr.parse_policy(self.good())


class SafetyAndDeterminism(unittest.TestCase):
    def test_replay_is_read_only_and_refuses_to_write_inside_the_raw_directory(self):
        d = tempfile.mkdtemp(); raw = os.path.join(d, "raw"); os.makedirs(raw)
        tr = tpr.Trace.synthetic({"gpu0": {"pkg": [70, 80]}}); rows = [{"t": float(i), "phase": "decode", "gpu": {"0000:00:00.0": {"temps": {"pkg": v}}}} for i, v in enumerate([70, 80])]
        with open(os.path.join(raw, "samples.jsonl"), "w") as f: f.write("\n".join(json.dumps(r) for r in rows) + "\n")
        pol = os.path.join(d, "p.json"); pdoc = {"name": "x", "status": "illustrative_example", "rules": [{"id": "a", "sensor_class": "package", "state": "warning", "threshold_c": 75}]}
        with open(pol, "w") as f: json.dump(pdoc, f)
        h = tpr.sha256_file(os.path.join(raw, "samples.jsonl"))
        self.assertEqual(tpr.main(["--raw", raw, "--policy", pol, "--out", os.path.join(d, "out"), "--quiet"]), 0)
        self.assertEqual(tpr.sha256_file(os.path.join(raw, "samples.jsonl")), h)
        self.assertEqual(tpr.main(["--raw", raw, "--policy", pol, "--out", os.path.join(raw, "results"), "--quiet"]), 2)
        self.assertFalse(os.path.exists(os.path.join(raw, "results"))); shutil.rmtree(d)
    def test_identical_inputs_give_identical_json(self):
        a = json.dumps(one([74, 76] * 5, persistence_s=2)[2], sort_keys=True); b = json.dumps(one([74, 76] * 5, persistence_s=2)[2], sort_keys=True); self.assertEqual(a, b)
    def test_dropout_injection_is_in_memory_and_labelled(self):
        tr = tpr.Trace.synthetic({"gpu0": {"vram": [80] * 6}}); tpr.inject_dropout(tr, "gpu0:vram:2:4")
        self.assertEqual([tr.temps[i]["gpu0"]["vram"] for i in range(6)], [80, 80, None, None, 80, 80]); self.assertIn("SYNTHETIC", tr.injections[0]["note"])


@unittest.skipUnless(os.path.exists(os.path.join(RAW, "samples.jsonl")), "preserved soak evidence not present")
class AgainstThePreservedSoak(unittest.TestCase):
    """Ties the tool to the already cross-checked what-if table (hottest sensor, loaded phases): the counts must reproduce."""
    @classmethod
    def setUpClass(cls): cls.trace = tpr.load_trace(RAW)
    def trips(self, gpu, thr, n):
        pol = tpr.parse_policy({"name": "g", "status": "illustrative_example", "rules": [{"id": "r", "sensor_class": "any_sensor", "state": "warning", "threshold_c": thr, "persistence_s": n, "gpus": [int(gpu[-1])]}]})
        # the earlier table counted loaded phases only; restrict the trace to them
        keep = [i for i, p in enumerate(self.trace.phase) if p in ("decode", "prefill")]
        sub = tpr.Trace(t=[self.trace.t[i] for i in keep], phase=[self.trace.phase[i] for i in keep], gpus=self.trace.gpus, temps=[self.trace.temps[i] for i in keep])
        return tpr.replay(sub, pol)["rules"][0]["trips"]
    def test_reproduces_the_published_persistence_table(self):
        for gpu, thr, n, expect in (("gpu0", 75, 1, 17), ("gpu0", 75, 60, 7), ("gpu1", 75, 1, 10), ("gpu1", 80, 1, 47), ("gpu1", 80, 30, 20), ("gpu1", 80, 60, 1), ("gpu1", 85, 1, 0)):
            self.assertEqual(self.trips(gpu, thr, n), expect, (gpu, thr, n))
    def test_vram_sensor_tracks_but_is_not_identical_to_the_hottest_channel_on_the_real_data(self):
        # Measured on the preserved soak: the firmware 'vram' sensor and the hottest of the 16 channels differ in 10 (gpu0) and 27 (gpu1) of
        # 3244 samples, always by exactly 2 C. They must stay separate classes; this pins the characterisation instead of assuming equality.
        for g, expected in (("gpu0", 10), ("gpu1", 27)):
            diffs = [tpr.class_value(self.trace.temps[i][g], "vram")[0] - tpr.class_value(self.trace.temps[i][g], "vram_hottest_channel")[0] for i in range(len(self.trace))]
            nonzero = [d for d in diffs if d != 0]
            self.assertEqual(len(nonzero), expected, g); self.assertEqual({abs(d) for d in nonzero}, {2.0}, g)
    def test_trace_loads_with_the_expected_shape(self):
        self.assertEqual((len(self.trace), self.trace.gpus, self.trace.dt), (3244, ["gpu0", "gpu1"], 1.0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
