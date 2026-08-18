/**
 * Minimal YAML subset parser for AITZAZ voice config.
 * Supports maps, lists of scalars, comments. No tags, anchors, or multiline blocks.
 */
export function parseSimpleYaml(src) {
  const lines = String(src).split(/\r?\n/);
  const built = {};
  const stack = [{ indent: -1, value: built }];

  const parseScalar = (raw) => {
    if (raw === undefined || raw === '') return '';
    const v = raw.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~') return null;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  };

  const current = () => stack[stack.length - 1];

  for (const rawLine of lines) {
    const hash = rawLine.search(/(^|\s)#/);
    const noComment = hash === -1 ? rawLine : rawLine.slice(0, hash);
    if (!noComment.trim()) continue;
    const indent = rawLine.match(/^ */)[0].length;
    const trimmed = noComment.trim();

    while (stack.length > 1 && indent <= current().indent) stack.pop();
    const parent = current();

    if (trimmed.startsWith('- ')) {
      const rest = trimmed.slice(2).trim();
      if (!Array.isArray(parent.value) && parent.parentMap && parent.key) {
        const arr = [];
        parent.parentMap[parent.key] = arr;
        parent.value = arr;
      }
      if (!Array.isArray(parent.value)) {
        throw new Error(`YAML list item without a list parent: ${trimmed}`);
      }
      parent.value.push(parseScalar(rest));
      continue;
    }

    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const val = trimmed.slice(colon + 1).trim();

    if (Array.isArray(parent.value)) {
      throw new Error(`YAML key "${key}" found inside a list`);
    }

    if (val === '' || val === '|' || val === '>') {
      const placeholder = {};
      parent.value[key] = placeholder;
      stack.push({ indent, value: placeholder, key, parentMap: parent.value });
    } else if (val === '[]') {
      parent.value[key] = [];
    } else if (val === '{}') {
      parent.value[key] = {};
    } else {
      parent.value[key] = parseScalar(val);
    }
  }

  return built;
}
