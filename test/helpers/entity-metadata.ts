import { getMetadataArgsStorage } from 'typeorm';

export type EntityClass = new () => object;

export function inspectEntity(target: EntityClass) {
  const storage = getMetadataArgsStorage();

  const columns = storage.columns.filter((column) => column.target === target);
  const relations = storage.relations.filter((relation) => relation.target === target);
  const joinColumns = storage.joinColumns.filter((joinColumn) => joinColumn.target === target);
  const generations = storage.generations.filter((generation) => generation.target === target);

  return {
    tableName: storage.tables.find((table) => table.target === target)?.name,
    indices: storage.indices.filter((index) => index.target === target),
    uniques: storage.uniques.filter((unique) => unique.target === target),
    column: (property: string) => columns.find((column) => column.propertyName === property),
    relation: (property: string) =>
      relations.find((relation) => relation.propertyName === property),
    joinColumn: (property: string) =>
      joinColumns.find((joinColumn) => joinColumn.propertyName === property),
    generation: (property: string) =>
      generations.find((generation) => generation.propertyName === property),
  };
}
