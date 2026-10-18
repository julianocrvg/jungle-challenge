/** O mínimo de `pg.Pool` e `pg.Client` usado aqui (pg é dependência transitiva do MikroORM). */
interface PooledClient {
  on(event: 'error', listener: (error: Error) => void): void;
  /** Atribuído pelo pg-pool a cada empréstimo; lança se chamado duas vezes no mesmo empréstimo. */
  release?: (error?: Error) => void;
}

interface ClientPool {
  on(event: 'connect', listener: (client: PooledClient) => void): void;
}

/**
 * Devolve ao pool, como quebrada, a conexão que o servidor derrubou enquanto estava emprestada.
 *
 * Kysely 0.29 (usado pelo MikroORM 7) só chama `release()` depois que o ROLLBACK dá certo. Numa conexão morta
 * (idle_in_transaction_session_timeout, restart do Postgres, pg_terminate_backend) o ROLLBACK lança erro, o
 * release nunca acontece e a vaga do pool se perde para sempre; com o pool inteiro perdido, a instância para.
 * O pg emite `'error'` no cliente quando a conexão cai; aqui chamamos `release(error)`, e o pg-pool descarta o
 * cliente e libera a vaga. Se o cliente estava ocioso no pool, `release` é a função do empréstimo anterior e lança
 * "already released": o próprio pg-pool já cuida dos ociosos, então o erro é ignorado (ARCHITECTURE 5.5).
 */
export function releaseClientsBrokenByServer(pool: ClientPool): void {
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      try {
        client.release?.(error);
      } catch {
        // Já devolvido ao pool: nada a fazer.
      }
    });
  });
}
