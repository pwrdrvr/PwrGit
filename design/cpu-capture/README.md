# PwrGit CPU capture rules

[Exported design](./PwrGit%20CPU%20Capture%20Rules.html) for Settings › Troubleshooting › Hot CPU Profiling.

- High CPU can be off, Spike, or Sustained. Slow burn is independent. The editor keeps at least one group enabled and remembers each rule's threshold and duration.
- Thresholds are inclusive whole percentages of one core, from 1 to 400. Spike has 1 or 2 seconds, Sustained has 4, 6, 10, or 20 seconds, and Slow burn has 4, 10, 30, or 60 seconds.
- Normal sampling is every two seconds. An enabled one-second Spike selects one-second sampling for every rule. The sampler checks elapsed time and consecutive hot intervals per target.
- With an environment cadence override, Spike uses one interval. Saved multi-sample rules round up to whole intervals, with at least two samples unless a scripted count or legacy timing applies.
- One triggering sample can match both rules. The capture records both in High CPU then Slow burn order. Sampling pauses during the capture. Rule changes clear pending samples and take effect without shortening an active profile.
- Defaults are Sustained at 50% for four seconds with Slow burn off. Spike remembers 50% for two seconds. Slow burn remembers 15% for four seconds. Arming is a separate setting.
