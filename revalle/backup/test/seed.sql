-- Banco de teste pequeno e autocontido (não depende da stack local).
CREATE TABLE notas (id serial PRIMARY KEY, texto text NOT NULL);
INSERT INTO notas (texto) VALUES ('um'), ('dois'), ('tres');
