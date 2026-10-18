// Outreach and inbox monitoring keep separate state/command queues. Claims and
// destructive tab operations must nevertheless use one shared critical section.
const owners = new Map();

export function withTabOwnership(tabId, task) {
  if (!Number.isInteger(tabId)) return Promise.resolve().then(task);
  const previous = owners.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  owners.set(tabId, current);
  return current.finally(() => {
    if (owners.get(tabId) === current) owners.delete(tabId);
  });
}
