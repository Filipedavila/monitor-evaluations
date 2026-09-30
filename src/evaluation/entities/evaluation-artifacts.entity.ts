import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Evaluation } from './evaluation.entity';

export type ArtifactType = 'assertions' | 'html' | 'conformance';
@Entity('evaluation_artifacts')
export class EvaluationArtifact {
  @PrimaryColumn({ name: 'evaluation_id', type: 'integer' })
  evaluationId: number;

  @PrimaryColumn({ name: 'artifact_type', type: 'text' })
  artifactType: ArtifactType;

  @Column({ name: 'file_size', type: 'bigint' })
  fileSize: number;

  @Column({ name: 'mime_type', type: 'text' })
  mimeType: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => Evaluation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'evaluation_id' })
  evaluation: Evaluation;
}
