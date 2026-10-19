ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin','owner'));
CREATE UNIQUE INDEX users_single_owner ON users(role) WHERE role='owner';
CREATE TABLE registration_invitations (
 id TEXT PRIMARY KEY,
 code_hash TEXT NOT NULL UNIQUE,
 code_hint TEXT NOT NULL,
 label TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 used_by TEXT REFERENCES users(id),
 used_at INTEGER,
 revoked_at INTEGER
);
CREATE INDEX invitations_creator_created ON registration_invitations(created_by,created_at DESC,id DESC);
ALTER TABLE users ADD COLUMN invitation_id TEXT REFERENCES registration_invitations(id);
CREATE TRIGGER registration_invitation_available BEFORE INSERT ON users
WHEN NEW.invitation_id IS NOT NULL
BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM registration_invitations i JOIN users issuer ON issuer.id=i.created_by
  WHERE i.id=NEW.invitation_id AND i.used_by IS NULL AND i.revoked_at IS NULL
  AND i.expires_at>unixepoch() AND issuer.role IN ('owner','admin')
 ) THEN RAISE(ABORT,'INVITATION_UNAVAILABLE') END;
END;
CREATE TRIGGER registration_invitation_used AFTER INSERT ON users
WHEN NEW.invitation_id IS NOT NULL
BEGIN
 UPDATE registration_invitations SET used_by=NEW.id,used_at=unixepoch() WHERE id=NEW.invitation_id;
END;
