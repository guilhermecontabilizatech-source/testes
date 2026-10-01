'use strict';

// Limita tentativas de login com senha errada, por e-mail+IP e por IP, numa janela de tempo.
// Fica em memória: reiniciar o servidor zera os contadores, o que é aceitável para um único servidor.
function criarLimitador({ janelaMs = 15 * 60 * 1000, maxPorConta = 5, maxPorIp = 30, agora = () => Date.now() } = {}) {
  const falhas = new Map(); // chave -> lista de horários de falha

  function recentes(chave) {
    const limite = agora() - janelaMs;
    const lista = (falhas.get(chave) ?? []).filter((t) => t > limite);
    if (lista.length) falhas.set(chave, lista); else falhas.delete(chave);
    return lista;
  }

  const chaves = (ip, email) => [`conta:${ip}:${String(email).toLowerCase()}`, `ip:${ip}`];

  return {
    // Devolve em quantos minutos poderá tentar de novo, ou 0 se está liberado.
    bloqueio(ip, email) {
      const [conta, porIp] = chaves(ip, email);
      const listaConta = recentes(conta);
      const listaIp = recentes(porIp);
      const bloqueada = listaConta.length >= maxPorConta ? listaConta : listaIp.length >= maxPorIp ? listaIp : null;
      if (!bloqueada) return 0;
      return Math.max(1, Math.ceil((bloqueada[0] + janelaMs - agora()) / 60000));
    },
    falhou(ip, email) {
      for (const chave of chaves(ip, email)) falhas.set(chave, [...recentes(chave), agora()]);
    },
    acertou(ip, email) {
      falhas.delete(chaves(ip, email)[0]);
    },
  };
}

module.exports = { criarLimitador };
