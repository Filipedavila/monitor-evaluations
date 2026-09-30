export interface UserReference {
  id: number;
}

export interface Auditable {
  createdAt: Date;
  updatedAt: Date;
  createdById: number | null;
  createdBy: UserReference | null;
  updatedById: number | null;
  updatedBy: UserReference | null;
}
