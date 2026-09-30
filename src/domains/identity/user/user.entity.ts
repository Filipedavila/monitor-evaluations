import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
import { IdentifiableModel } from '../../../common/interfaces/Identifiable.interface';

@Entity('users')
export class User implements IdentifiableModel {
  @PrimaryGeneratedColumn('identity', { generatedIdentity: 'BY DEFAULT' })
  id: number;

  @Column({ name: 'username', type: 'varchar', length: 150, nullable: false })
  username: string;
}
