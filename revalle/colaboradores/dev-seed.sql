-- Base FICTÍCIA de desenvolvimento do RevSign (nunca usar em produção).
-- Mesmo contrato da view real (spec §6.1). CPFs válidos gerados só para teste.
--
-- | # | Nome                        | CPF          | Nascimento | E-mail                   | Situação  | Unidade           |
-- |---|-----------------------------|--------------|------------|--------------------------|-----------|-------------------|
-- | 1 | Maria Teste da Silva        | 39053344705  | 1990-03-07 | (sem e-mail)             | ativo     | Juazeiro          |
-- | 2 | João Exemplo Pereira        | 52871936455  | 1985-11-20 | com.email@revalle.com.br | ativo     | Petrolina         |
-- | 3 | Ana Fictícia Souza          | 74612058380  | 1978-01-15 | (sem e-mail)             | desligado | Senhor do Bonfim  |
-- | 4 | Carlos Simulado Lima        | 21598467085  | 1995-06-30 | (sem e-mail)             | afastado  | Paulo Afonso      |
-- | 5 | Beatriz Modelo Andrade      | 68340192787  | 1988-09-09 | (sem e-mail)             | ativo     | Ribeira do Pombal |
-- | 6 | Fernando Ensaio Barbosa     | 93457210888  | 1999-12-31 | (sem e-mail)             | ativo     | Serrinha          |
--
-- Role de leitura: revsign_leitura / revsign_leitura_dev (só desenvolvimento).
-- Só enxerga a view; a tabela rh_colaboradores é negada.

CREATE TABLE rh_colaboradores (
  id              serial PRIMARY KEY,
  cpf_completo    text NOT NULL,
  nome_completo   text NOT NULL,
  nascimento      date NOT NULL,
  cargo_nome      text,
  setor_nome      text,
  unidade_nome    text,
  matricula_rh    text,
  email_corp      text,
  celular         text,
  status_rh       text NOT NULL
);

INSERT INTO rh_colaboradores
  (cpf_completo, nome_completo, nascimento, cargo_nome, setor_nome, unidade_nome, matricula_rh, email_corp, celular, status_rh)
VALUES
  ('39053344705', 'Maria Teste da Silva',    '1990-03-07', 'Analista Administrativo', 'Administrativo', 'Juazeiro',          '90001', NULL,                       NULL, 'ativo'),
  ('52871936455', 'João Exemplo Pereira',    '1985-11-20', 'Supervisor de Vendas',    'Comercial',      'Petrolina',         '90002', 'com.email@revalle.com.br', NULL, 'ativo'),
  ('74612058380', 'Ana Fictícia Souza',      '1978-01-15', 'Auxiliar de Logística',   'Logística',      'Senhor do Bonfim',  '90003', NULL,                       NULL, 'desligado'),
  ('21598467085', 'Carlos Simulado Lima',    '1995-06-30', 'Motorista',               'Entrega',        'Paulo Afonso',      '90004', NULL,                       NULL, 'afastado'),
  ('68340192787', 'Beatriz Modelo Andrade',  '1988-09-09', 'Assistente Financeiro',   'Financeiro',     'Ribeira do Pombal', '90005', NULL,                       NULL, 'ativo'),
  ('93457210888', 'Fernando Ensaio Barbosa', '1999-12-31', 'Vendedor',                'Comercial',      'Serrinha',          '90006', NULL,                       NULL, 'ativo');

CREATE VIEW vw_colaboradores_assinatura AS
SELECT
  cpf_completo  AS cpf,
  nome_completo AS nome,
  nascimento    AS data_nascimento,
  cargo_nome    AS cargo,
  setor_nome    AS setor,
  unidade_nome  AS unidade,
  matricula_rh  AS matricula,
  email_corp    AS email,
  celular       AS telefone,
  status_rh     AS situacao
FROM rh_colaboradores;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

CREATE ROLE revsign_leitura LOGIN PASSWORD 'revsign_leitura_dev';
REVOKE ALL ON DATABASE colaboradores FROM PUBLIC;
GRANT CONNECT ON DATABASE colaboradores TO revsign_leitura;
GRANT USAGE ON SCHEMA public TO revsign_leitura;
-- A view pertence ao superusuário e lê a tabela com os direitos dele.
GRANT SELECT ON vw_colaboradores_assinatura TO revsign_leitura;
