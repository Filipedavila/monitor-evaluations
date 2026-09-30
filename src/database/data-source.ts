import { DataSource } from 'typeorm';
import { Env } from '../config/env';
import { Page } from '../domains/inventory/page/page.entity';
import { User } from '../domains/identity/user/user.entity';
import { Context } from '../domains/inventory/context/context.identity';
import { Evaluation } from '../evaluation/entities/evaluation.entity';
import { EvaluationContext } from '../evaluation/entities/contexts-evaluation.entity';
import { EvaluationArtifact } from '../evaluation/entities/evaluation-artifacts.entity';

export function createDataSource(env: Env): DataSource {
  return new DataSource({
    type: 'postgres',
    host: env.DB_HOST,
    port: 5432,
    username: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: env.DB_DATABASE,
    entities: [Page, User, Context, Evaluation, EvaluationContext, EvaluationArtifact],
    synchronize: false,
    logging: env.NODE_ENV === 'development' ? ['error', 'schema'] : ['error'],
  });
}
