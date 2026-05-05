/**
 * Gmail Parent Label Sync — Google Apps Script
 *
 * Ensures threads with nested child labels also have ancestor labels applied.
 * e.g. A thread labeled "bills/banking/bmo" also gets "bills/banking" and "bills".
 *
 * SETUP:
 * 1. Go to https://script.google.com
 * 2. Create a new project, paste this code
 * 3. Run setupTrigger() once to create the 6-hour recurring trigger
 * 4. Authorize when prompted (Gmail access)
 *
 * To disable: Run removeTrigger()
 */

function syncParentLabels() {
  const allLabels = GmailApp.getUserLabels();

  // Build name -> label object map
  const labelMap = {};
  for (const label of allLabels) {
    labelMap[label.getName()] = label;
  }

  // Find all nested labels (containing "/"), skip archives
  const nestedLabels = allLabels.filter(l => {
    const name = l.getName();
    return name.includes('/') && !name.startsWith('z[');
  });

  let totalModified = 0;

  for (const childLabel of nestedLabels) {
    const childName = childLabel.getName();
    const parts = childName.split('/');

    if (parts.length < 2) continue;

    // Build list of ancestor label objects
    const ancestors = [];
    for (let i = 1; i < parts.length; i++) {
      const ancestorName = parts.slice(0, i).join('/');
      if (labelMap[ancestorName]) {
        ancestors.push(labelMap[ancestorName]);
      }
    }

    if (ancestors.length === 0) continue;

    // Only process recent threads (last 24 hours) to stay within quota
    // Using search instead of label.getThreads() for date filtering
    const query = 'label:' + childName.replace(/ /g, '-') + ' newer_than:1d';
    let threads;
    try {
      threads = GmailApp.search(query, 0, 100);
    } catch (e) {
      Logger.log('Search failed for ' + childName + ': ' + e.message);
      continue;
    }

    if (threads.length === 0) continue;

    for (const thread of threads) {
      const existingLabels = thread.getLabels();
      const existingNames = new Set(existingLabels.map(l => l.getName()));

      for (const ancestor of ancestors) {
        if (!existingNames.has(ancestor.getName())) {
          thread.addLabel(ancestor);
          totalModified++;
        }
      }
    }
  }

  Logger.log('Parent label sync complete: ' + totalModified + ' labels added');
  return totalModified;
}

/** Run once to set up the recurring 6-hour trigger */
function setupTrigger() {
  // Remove any existing triggers first
  removeTrigger();

  ScriptApp.newTrigger('syncParentLabels')
    .timeBased()
    .everyHours(6)
    .create();

  Logger.log('Trigger created: syncParentLabels every 6 hours');
}

/** Remove all triggers for this function */
function removeTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'syncParentLabels') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  Logger.log('All syncParentLabels triggers removed');
}
