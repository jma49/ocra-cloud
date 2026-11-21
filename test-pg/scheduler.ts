// workerd's scheduler.wait, which some tests use to let a stream run.
Object.assign(globalThis, {
  scheduler: { wait: (ms: number) => new Promise((done) => setTimeout(done, ms)) },
});
