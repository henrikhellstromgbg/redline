(function installRedlineTargeting(global) {
  "use strict";

  function escapeAttributeValue(value) {
    return String(value).replace(/[\0-\x1f\x7f"\\]/g, (character) => {
      if (character === "\0") return "\ufffd";
      if (character === '"' || character === "\\") return `\\${character}`;
      return `\\${character.codePointAt(0).toString(16)} `;
    });
  }

  function attributeSelector(name, value) {
    if (!/^[a-z][a-z0-9_-]*$/i.test(name)) {
      throw new TypeError(`Invalid attribute name: ${String(name)}`);
    }
    return `[${name}="${escapeAttributeValue(value)}"]`;
  }

  global.RedlineTargeting = Object.freeze({
    escapeAttributeValue,
    attributeSelector
  });
})(globalThis);
