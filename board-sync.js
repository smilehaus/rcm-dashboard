/*
 * Board sync rules for the Live Status tab.
 * Loaded as a classic script (window.RCMBoard) and as an ES module side effect
 * (globalThis.RCMBoard) so node tests and the page share one implementation.
 *
 * The page used to PUT the entire in-memory board, and that memory starts as
 * the hardcoded starter roster (former employees, no IV dates). A failed
 * Firebase read, or a tab still running an old cached page, then saved that
 * starter roster over the real one. These helpers make that overwrite lose.
 */
(function (root, factory) {
  root.RCMBoard = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var CLIENT_BUILD = 2026111201;
  var EMPTY_CELL = "__rcm_empty__";
  var SEED_STAFF_IDS = [
    "adela", "vanessa", "valerie", "becky", "brittani", "lovely", "princess",
    "rob", "kirk", "myk", "gianna", "alexis", "lynn", "own_team"
  ];

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function J(v) {
    return JSON.stringify(v == null ? null : v);
  }

  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function looksLikeSeedRoster(state) {
    if (!state || !Array.isArray(state.staff)) return false;
    var ids = state.staff.map(function (s) { return s && s.id; }).filter(Boolean).sort();
    var seed = SEED_STAFF_IDS.slice().sort();
    if (ids.length !== seed.length) return false;
    for (var i = 0; i < ids.length; i++) if (ids[i] !== seed[i]) return false;
    var iv = state.ivDates;
    if (iv && typeof iv === "object" && !Array.isArray(iv) && Object.keys(iv).length > 0) return false;
    return true;
  }

  function shouldIgnoreRemote(local, remote) {
    if (!remote) return false;
    if (looksLikeSeedRoster(remote) && !looksLikeSeedRoster(local || {})) return true;
    return false;
  }

  function clientMayWrite(clientBuild, remote) {
    if (!remote) return true;
    var min = Number(remote._minBuild || remote._clientBuild || 0);
    if (min && Number(clientBuild) < min) return false;
    return true;
  }

  function writeWouldClobberRoster(local, remote) {
    if (!remote) return false;
    return looksLikeSeedRoster(local) && !looksLikeSeedRoster(remote);
  }

  function archiveEntries(state) {
    var out = [];
    var seen = {};
    asArray(state && state.staffArchive).forEach(function (t) {
      if (t && t.id && !seen[t.id]) {
        seen[t.id] = true;
        out.push({
          id: t.id,
          name: t.name || "",
          inactiveReason: t.inactiveReason || "",
          inactiveDate: t.inactiveDate || ""
        });
      }
    });
    asArray(state && state.staff).forEach(function (s) {
      if (s && s.id && s.dept === "Inactive" && !seen[s.id]) {
        seen[s.id] = true;
        out.push({
          id: s.id,
          name: s.name || "",
          inactiveReason: s.inactiveReason || "",
          inactiveDate: s.inactiveDate || ""
        });
      }
    });
    return out;
  }

  function indexById(arr) {
    var map = {};
    asArray(arr).forEach(function (s) { if (s && s.id) map[s.id] = s; });
    return map;
  }

  function reactivatedIds(base, local) {
    var ids = {};
    var baseStaff = indexById(base && base.staff);
    var baseArch = {};
    archiveEntries(base).forEach(function (t) { baseArch[t.id] = true; });
    asArray(local && local.staff).forEach(function (ls) {
      if (!ls || !ls.id) return;
      var bs = baseStaff[ls.id];
      var wasInactive = (bs && bs.dept === "Inactive") || baseArch[ls.id];
      if (wasInactive && ls.dept !== "Inactive" && J(bs || null) !== J(ls)) ids[ls.id] = true;
    });
    return ids;
  }

  function mergeOffices(base, local, remote) {
    function byCode(list) {
      var map = {};
      asArray(list).forEach(function (o) { if (o && o.code) map[o.code] = o; });
      return map;
    }
    var b = byCode(base.offices);
    var l = byCode(local.offices);
    var r = byCode(remote.offices);
    var codes = {};
    [b, l, r].forEach(function (m) { Object.keys(m).forEach(function (c) { codes[c] = true; }); });
    var result = [];
    Object.keys(codes).sort().forEach(function (code) {
      var rb = r[code], lb = l[code], bb = b[code];
      if (lb && rb) {
        result.push(clone(J(bb || null) !== J(lb) ? lb : rb));
      } else if (lb && !rb) {
        if (!bb || J(bb) !== J(lb)) result.push(clone(lb));
      } else if (!lb && rb) {
        if (!(bb && !lb)) result.push(clone(rb));
      }
    });
    return result;
  }

  function mergeIvDates(base, local, remote) {
    var baseIv = (base.ivDates && typeof base.ivDates === "object") ? base.ivDates : {};
    var locIv = (local.ivDates && typeof local.ivDates === "object") ? local.ivDates : {};
    var remIv = clone((remote.ivDates && typeof remote.ivDates === "object") ? remote.ivDates : {});
    var keys = {};
    Object.keys(baseIv).forEach(function (k) { keys[k] = true; });
    Object.keys(locIv).forEach(function (k) { keys[k] = true; });
    Object.keys(keys).forEach(function (k) {
      if (J(baseIv[k] == null ? null : baseIv[k]) === J(locIv[k] == null ? null : locIv[k])) return;
      if (locIv[k] == null || locIv[k] === "") delete remIv[k];
      else remIv[k] = locIv[k];
    });
    return remIv;
  }

  function mergeTokenCell(baseCell, locCell, remoteCell) {
    var baseArr = asArray(baseCell);
    var locArr = asArray(locCell);
    if (J(baseArr) === J(locArr)) return asArray(remoteCell).slice();
    var remoteArr = asArray(remoteCell);
    var added = locArr.filter(function (x) { return baseArr.indexOf(x) === -1; });
    var removed = baseArr.filter(function (x) { return locArr.indexOf(x) === -1; });
    var result = remoteArr.filter(function (x) { return removed.indexOf(x) === -1; });
    added.forEach(function (x) { if (result.indexOf(x) === -1) result.push(x); });
    return result;
  }

  function mergeBoardState(base, local, remote) {
    base = base || {};
    local = local || {};
    remote = remote || {};
    var merged = clone(remote);

    ["live", "assign"].forEach(function (board) {
      if (!merged[board] || typeof merged[board] !== "object" || Array.isArray(merged[board])) {
        merged[board] = clone(local[board] || {});
      }
      var baseB = base[board] || {};
      var locB = local[board] || {};
      var offices = {};
      Object.keys(baseB).forEach(function (o) { offices[o] = true; });
      Object.keys(locB).forEach(function (o) { offices[o] = true; });
      Object.keys(offices).forEach(function (off) {
        var baseCols = baseB[off] || {};
        var locCols = locB[off] || {};
        var cols = {};
        Object.keys(baseCols).forEach(function (c) { cols[c] = true; });
        Object.keys(locCols).forEach(function (c) { cols[c] = true; });
        Object.keys(cols).forEach(function (col) {
          if (J(asArray(baseCols[col])) === J(asArray(locCols[col]))) return;
          merged[board] = merged[board] || {};
          merged[board][off] = merged[board][off] || {};
          var remoteCell = merged[board][off][col];
          merged[board][off][col] = mergeTokenCell(baseCols[col], locCols[col], remoteCell);
        });
      });
    });

    ["lunch", "off"].forEach(function (arr) {
      merged[arr] = mergeTokenCell(base[arr], local[arr], merged[arr]);
    });

    var revived = reactivatedIds(base, local);
    var tomb = {};
    [base, remote, local].forEach(function (src) {
      archiveEntries(src).forEach(function (t) {
        if (revived[t.id]) return;
        if (!tomb[t.id]) tomb[t.id] = t;
      });
    });

    var baseBy = indexById(base.staff);
    var localBy = indexById(local.staff);
    var remoteArr = asArray(merged.staff);
    var remoteIds = {};
    var staffResult = remoteArr.map(function (rs) {
      if (!rs || !rs.id) return rs;
      remoteIds[rs.id] = true;
      var ls = localBy[rs.id];
      var bs = baseBy[rs.id];
      var chosen = rs;
      if (ls && J(bs || null) !== J(ls)) chosen = clone(ls);
      else chosen = clone(rs);
      if (tomb[rs.id]) {
        var t = tomb[rs.id];
        chosen.dept = "Inactive";
        chosen.inactiveReason = t.inactiveReason || chosen.inactiveReason || "";
        chosen.inactiveDate = t.inactiveDate || chosen.inactiveDate || "";
      }
      return chosen;
    });
    asArray(local.staff).forEach(function (ls) {
      if (!ls || !ls.id) return;
      if (!remoteIds[ls.id] && !baseBy[ls.id] && !tomb[ls.id]) staffResult.push(clone(ls));
    });
    Object.keys(tomb).forEach(function (id) {
      if (staffResult.some(function (s) { return s && s.id === id; })) return;
      var src = localBy[id] || indexById(remote.staff)[id] || baseBy[id] || { id: id, name: tomb[id].name || id };
      var copy = clone(src);
      copy.dept = "Inactive";
      copy.inactiveReason = tomb[id].inactiveReason || copy.inactiveReason || "";
      copy.inactiveDate = tomb[id].inactiveDate || copy.inactiveDate || "";
      staffResult.push(copy);
    });
    merged.staff = staffResult.filter(Boolean);
    merged.staffArchive = Object.keys(tomb).map(function (id) { return tomb[id]; });
    merged.offices = mergeOffices(base, local, remote);
    merged.ivDates = mergeIvDates(base, local, remote);

    Object.keys(local).forEach(function (k) {
      if (k === "live" || k === "assign" || k === "lunch" || k === "off" || k === "staff"
        || k === "staffArchive" || k === "offices" || k === "ivDates" || k.charAt(0) === "_") return;
      if (J(base[k]) !== J(local[k])) merged[k] = clone(local[k]);
    });

    stripInactiveTokens(merged);
    return merged;
  }

  function inactiveIdSet(state) {
    var dead = {};
    archiveEntries(state).forEach(function (t) { dead[t.id] = true; });
    asArray(state && state.staff).forEach(function (s) {
      if (s && s.id && s.dept === "Inactive") dead[s.id] = true;
    });
    return dead;
  }

  function stripList(arr, dead) {
    return asArray(arr).filter(function (id) {
      return id !== EMPTY_CELL && !dead[id];
    });
  }

  function stripInactiveTokens(state) {
    if (!state) return state;
    var dead = inactiveIdSet(state);
    ["live", "assign"].forEach(function (board) {
      var tree = state[board];
      if (!tree || typeof tree !== "object") return;
      Object.keys(tree).forEach(function (off) {
        var cols = tree[off];
        if (!cols || typeof cols !== "object") return;
        Object.keys(cols).forEach(function (col) {
          if (Array.isArray(cols[col])) cols[col] = stripList(cols[col], dead);
        });
      });
    });
    ["lunch", "off"].forEach(function (key) {
      if (Array.isArray(state[key])) state[key] = stripList(state[key], dead);
    });
    return state;
  }

  function encodeCell(cell) {
    if (!Array.isArray(cell) || cell.length === 0) return [EMPTY_CELL];
    return cell.filter(function (id) { return id !== EMPTY_CELL; });
  }

  function decodeCell(cell) {
    if (!Array.isArray(cell)) return cell;
    var real = cell.filter(function (id) { return id !== EMPTY_CELL; });
    return real;
  }

  function encodeEmpties(state) {
    if (!state) return state;
    ["live", "assign"].forEach(function (board) {
      var tree = state[board];
      if (!tree || typeof tree !== "object") return;
      Object.keys(tree).forEach(function (off) {
        var cols = tree[off];
        if (!cols || typeof cols !== "object" || Array.isArray(cols)) return;
        Object.keys(cols).forEach(function (col) {
          if (Array.isArray(cols[col])) cols[col] = encodeCell(cols[col]);
        });
      });
    });
    ["lunch", "off"].forEach(function (key) {
      if (Array.isArray(state[key])) state[key] = encodeCell(state[key]);
    });
    return state;
  }

  function decodeEmpties(state) {
    if (!state) return state;
    ["live", "assign"].forEach(function (board) {
      var tree = state[board];
      if (!tree || typeof tree !== "object") return;
      Object.keys(tree).forEach(function (off) {
        var cols = tree[off];
        if (!cols || typeof cols !== "object" || Array.isArray(cols)) return;
        Object.keys(cols).forEach(function (col) {
          if (Array.isArray(cols[col])) cols[col] = decodeCell(cols[col]);
        });
      });
    });
    ["lunch", "off"].forEach(function (key) {
      if (Array.isArray(state[key])) state[key] = decodeCell(state[key]);
    });
    return state;
  }

  return {
    CLIENT_BUILD: CLIENT_BUILD,
    EMPTY_CELL: EMPTY_CELL,
    SEED_STAFF_IDS: SEED_STAFF_IDS,
    looksLikeSeedRoster: looksLikeSeedRoster,
    shouldIgnoreRemote: shouldIgnoreRemote,
    clientMayWrite: clientMayWrite,
    writeWouldClobberRoster: writeWouldClobberRoster,
    mergeBoardState: mergeBoardState,
    stripInactiveTokens: stripInactiveTokens,
    encodeEmpties: encodeEmpties,
    decodeEmpties: decodeEmpties,
    archiveEntries: archiveEntries
  };
});
