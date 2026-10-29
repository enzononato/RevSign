-- RevSign: modelo para criar, na base real de RH, a view e o usuário SOMENTE LEITURA.
-- Rode como administrador do banco. Troque tudo que está entre < > pelos nomes reais.
-- Nada aqui altera dados: só cria uma view e um usuário que enxerga apenas a view.

-- 1) A view. Cada linha mapeia uma coluna real para um campo do contrato.
--    Regras do contrato:
--      cpf: só dígitos, 11 caracteres (se a base guarda com máscara, use regexp_replace)
--      data_nascimento: tipo date
--      unidade: Juazeiro, Senhor do Bonfim, Petrolina, Paulo Afonso, Ribeira do Pombal, Serrinha, Alagoinhas
--      situacao: ativo, afastado ou desligado (não filtre ninguém: desligados e afastados também assinam)
--      email: PODE SER NULO. Hoje a base não tem e-mails, então pode usar NULL::text.
CREATE OR REPLACE VIEW vw_colaboradores_assinatura AS
SELECT
  regexp_replace(t.<coluna_cpf>, '\D', '', 'g')::text AS cpf,
  t.<coluna_nome>::text                               AS nome,
  t.<coluna_data_nascimento>::date                    AS data_nascimento,
  t.<coluna_cargo>::text                              AS cargo,
  t.<coluna_setor>::text                              AS setor,
  t.<coluna_unidade>::text                            AS unidade,
  t.<coluna_matricula>::text                          AS matricula,
  t.<coluna_email>::text                              AS email,      -- ou NULL::text
  t.<coluna_telefone>::text                           AS telefone,   -- ou NULL::text
  t.<coluna_situacao>::text                           AS situacao
FROM <tabela> t;

-- 2) O usuário de leitura. Defina uma senha forte no lugar de <definir>.
CREATE ROLE revsign_leitura LOGIN PASSWORD '<definir>';

-- 3) Só a view. Nenhum acesso a tabelas.
--    ATENÇÃO: não revogue nada de PUBLIC no banco real (isso tiraria o acesso de outros usuários).
--    A view precisa pertencer a um papel que consiga LER a tabela <tabela> (o dono da view é quem
--    é checado ao ler a tabela, não o revsign_leitura).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM revsign_leitura;
GRANT CONNECT ON DATABASE <banco> TO revsign_leitura;
GRANT USAGE ON SCHEMA public TO revsign_leitura;
GRANT SELECT ON vw_colaboradores_assinatura TO revsign_leitura;

-- 3b) Confira que PUBLIC (qualquer usuário do banco) NÃO pode ler a tabela. Resposta sim/não:
SELECT has_table_privilege('public', '<tabela>', 'SELECT') AS publico_pode_ler;
--     Se aparecer f (falso): está correto.
--     Se aparecer t (verdadeiro): qualquer usuário do banco consegue ler a tabela, inclusive o revsign_leitura.
--     Peça ao dono da tabela/TI para rodar:  REVOKE SELECT ON <tabela> FROM PUBLIC;
--     (avalie antes se outros usuários dependem disso).
--     Detalhe opcional, no psql:  \dp <tabela>  (qualquer entrada sem nome antes do "=" que contenha a letra r).

-- 3c) Confira o usuário de leitura. O primeiro deve dar f e o segundo deve dar t:
SELECT has_table_privilege('revsign_leitura', '<tabela>', 'SELECT') AS le_a_tabela;
SELECT has_table_privilege('revsign_leitura', 'vw_colaboradores_assinatura', 'SELECT') AS le_a_view;

-- 4) Teste (conectado como revsign_leitura): deve listar pessoas.
--    Já a mesma consulta na tabela <tabela> deve dar "permission denied".
SELECT count(*) FROM vw_colaboradores_assinatura;
SELECT cpf, nome, unidade, situacao FROM vw_colaboradores_assinatura LIMIT 3;

-- Depois, a URL de conexão para o RevSign (variável COLABORADORES_DATABASE_URL):
--   postgres://revsign_leitura:<senha>@<host>:5432/<banco>
