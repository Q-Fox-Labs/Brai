# ABOUTME: Проверяет owner migration Artifacts без модели и пользовательских данных.
# ABOUTME: Политика ownership и SQL-контракт проверяются на синтетических typed snapshots.
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('artifact_ownership', Path(__file__).resolve().parents[1] / 'ownership_migration.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)
AID = '00000000-0000-4000-8000-000000000001'
BID = '00000000-0000-4000-8000-000000000002'
QID = '00000000-0000-4000-8000-000000000003'


def fixture():
    snapshot = {name:[] for name in migration.TABLES}
    for aid in (AID,BID,QID):
        artifact = {'artifactId':aid,'requestId':'r-'+aid,'ownerId':'original','kind':'original',
                    'status':'ready','source':'agent','sizeBytes':5,'sha256':'a'*64,
                    'createdAt':'2026-11-05T00:00:00+00:00','updatedAt':'2026-11-05T00:00:00+00:00'}
        snapshot['artifacts'].append({'artifact_id':aid,'request_id':artifact['requestId'],'owner_id':'original',
            'kind':'original','status':'ready','source':'agent','size_bytes':5,
            'created_at':artifact['createdAt'],'upload_token':'private-'+aid,
            'document':{'artifact':artifact,'prepareInput':{'ownerId':'original','metadata':{'filename':"file'$brai_owner_0$.txt"}},
                        'unknownField':{'preserve':True}}})
    config={'version':1,'runId':'fixture','originalOwnerId':'original','quarantineOwnerId':'quarantine-fixture',
            'allowedOwners':['original','foreign'],'accountsHash':'a'*64,'provenanceHash':'b'*64,
            'ownerSoftwareHash':'c'*64,'assignments':{AID:'original',BID:'foreign'}}
    return snapshot, config


class OwnershipTest(unittest.TestCase):
    def test_ids_bytes_timestamps_unknown_metadata_and_request_ids_are_preserved(self):
        source,config=fixture()
        plan=migration.build_plan(source,config)
        self.assertEqual(plan['summary']['transferred'],1)
        self.assertEqual(plan['summary']['quarantined'],1)
        for before,after in zip(plan['before']['artifacts'],plan['after']['artifacts']):
            unchanged=copy.deepcopy(after)
            unchanged['owner_id']=before['owner_id']
            unchanged['document']['artifact']['ownerId']=before['document']['artifact']['ownerId']
            unchanged['document']['prepareInput']['ownerId']=before['document']['prepareInput']['ownerId']
            self.assertEqual(unchanged,before)

    def test_unproven_reference_and_output_are_archived_not_left_visible_to_original(self):
        source,config=fixture()
        reference={'owner_id':'original','project_id':'p','thread_id':'t','operation_id':'o',
                   'document':{'scope':{'ownerId':'original'},'attachments':[{'originalArtifactId':BID,'modelArtifactId':BID}]}}
        output={'owner_id':'original','project_id':'p','thread_id':'t','item_id':'i',
                'document':{'ownerId':'original','artifactIds':[AID,BID]}}
        source['references']=[reference]
        source['outputs']=[output]
        plan=migration.build_plan(source,config)
        self.assertEqual(plan['after']['references'],[])
        self.assertEqual(plan['after']['outputs'],[])
        self.assertEqual(plan['before']['references'],[reference])
        self.assertEqual(plan['summary']['archivedReferences'],1)

    def test_binding_moves_only_with_independent_owner_proof(self):
        source,config=fixture()
        row={'owner_id':'original','project_id':'p','thread_id':'t','item_id':'i',
             'document':{'ownerId':'original','artifactIds':[BID],'createdAt':'unchanged'}}
        source['outputs']=[row]
        config['bindingOwners']={'outputs':{migration.digest(list(migration.key('outputs',row))):'foreign'}}
        result=migration.build_plan(source,config)['after']['outputs'][0]
        self.assertEqual(result['owner_id'],'foreign')
        self.assertEqual(result['document']['ownerId'],'foreign')
        self.assertEqual(result['document']['createdAt'],'unchanged')
        self.assertEqual(result['item_id'],row['item_id'])

    def test_mixed_relation_component_is_quarantined(self):
        source,config=fixture()
        source['relations']=[{'model_artifact_id':BID,'original_artifact_id':AID,'document':{}}]
        plan=migration.build_plan(source,config)
        self.assertEqual(plan['summary']['quarantined'],3)

    def test_sql_is_transactional_cas_and_typed_archive_without_unsafe_dollar_delimiter(self):
        source,config=fixture()
        plan=migration.build_plan(source,config)
        sql=migration.migration_sql(plan,'apply',runtime_roles=['fixture_app'])
        self.assertIn('artifacts_snapshots',sql)
        self.assertIn('ARTIFACT_OWNER_CAS_FAILED',sql)
        self.assertIn('SHARE ROW EXCLUSIVE',sql)
        self.assertIn("SET LOCAL standard_conforming_strings=on",sql)
        self.assertIn('DO $brai_owner_1$',sql)
        self.assertNotIn('DO $owner$ BEGIN',sql)
        self.assertIn('REVOKE ALL ON ALL TABLES',sql)
        self.assertTrue(sql.rstrip().endswith('COMMIT;'))
        verify=migration.migration_sql(plan,'verify')
        self.assertIn('READ ONLY',verify)
        self.assertNotIn('UPDATE artifacts.artifacts',verify)
        changed=copy.deepcopy(plan)
        changed['after']['artifacts'][0]['document']['unknownField']='tampered'
        with self.assertRaises(migration.MigrationError):
            migration.migration_sql(changed,'apply')


if __name__=='__main__':
    unittest.main()
