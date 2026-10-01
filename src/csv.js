'use strict';

// Monta um CSV separado por ";" (padrão do Excel em português), com BOM para acentuação.
function paraCsv(linhas) {
  const esc = (v) => {
    let t = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // evita injeção de fórmulas em planilhas
    return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return '﻿' + linhas.map((l) => l.map(esc).join(';')).join('\r\n');
}

const reais = (centavos) => ((centavos ?? 0) / 100).toFixed(2).replace('.', ',');

module.exports = { paraCsv, reais };
