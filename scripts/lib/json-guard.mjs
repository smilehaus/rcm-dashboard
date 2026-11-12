/**
 * Shared checks for generated dashboard JSON.
 * A file that does not parse, or that still contains git conflict markers,
 * must never be committed — that is what turns into the red
 * "Scheduler missed a refresh" banner.
 */

const CONFLICT_MARKER = /^(<{7})( |$)|^(={7})$|^(>{7})( |$)/m;

const SCHEMAS = {
  "aging-alerts.json"(data) {
    return isObject(data.offices) && isNonEmptyString(data.generated);
  },
  "resubmit-alerts.json"(data) {
    return isObject(data.offices) && isNonEmptyString(data.generated);
  },
  "posting-alerts.json"(data) {
    return isObject(data.offices) && isNonEmptyString(data.generated);
  },
  "kpi-snapshot.json"(data) {
    return Array.isArray(data.weeks) && isNonEmptyString(data.generated);
  },
  "ar-snapshot.json"(data) {
    return isObject(data.offices) && isNonEmptyString(data.generated);
  },
  "ar-history-backup.json"(data) {
    return Array.isArray(data.perOfficeHistory);
  },
  "statement-dates.json"(data) {
    return isObject(data) && (data.offices == null || isObject(data.offices));
  },
  "build.json"(data) {
    return Number.isFinite(data.build) && Number.isFinite(data.minBuild);
  },
  "board-baseline.json"(data) {
    return Array.isArray(data.staff) && data.staff.length > 14
      && Array.isArray(data.offices) && isObject(data.ivDates)
      && Object.keys(data.ivDates).length > 0;
  },
};

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

export function findConflictMarkers(text) {
  const lines = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    if (CONFLICT_MARKER.test(line)) lines.push(i + 1);
  });
  return lines;
}

export function parseDashboardJson(text, fileLabel = "json") {
  const markerLines = findConflictMarkers(text);
  if (markerLines.length) {
    throw new Error(`${fileLabel} contains git conflict markers on line ${markerLines.join(", ")}`);
  }
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new Error(`${fileLabel} is not valid JSON: ${err.message}`);
  }
}

export function assertPublishable(fileLabel, text) {
  const data = parseDashboardJson(text, fileLabel);
  const base = fileLabel.split("/").pop();
  const schema = SCHEMAS[base];
  if (schema && !schema(data)) {
    throw new Error(`${fileLabel} failed schema check`);
  }
  return data;
}

export { SCHEMAS };
