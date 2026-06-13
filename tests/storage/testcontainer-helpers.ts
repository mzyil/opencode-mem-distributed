import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

export async function startPostgres(): Promise<{
  url: string;
  stop: () => Promise<void>;
  container: StartedPostgreSqlContainer;
}> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  return {
    container,
    url: container.getConnectionUri(),
    stop: () => container.stop(),
  };
}

export async function startPostgresWithVector(): Promise<{
  url: string;
  stop: () => Promise<void>;
  container: StartedPostgreSqlContainer;
}> {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  return {
    container,
    url: container.getConnectionUri(),
    stop: () => container.stop(),
  };
}
