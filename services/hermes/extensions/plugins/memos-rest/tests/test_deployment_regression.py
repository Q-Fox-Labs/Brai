import unittest
from test_provider import ProviderTests

class DeploymentRegressionTests(ProviderTests):
    def test_admin_cli_supports_unambiguous_scope_profile_flag(self):
        import argparse,importlib
        cli=importlib.import_module(self.provider.__class__.__module__.rsplit('.',1)[0]+'.cli')
        parser=argparse.ArgumentParser()
        cli.register_cli(parser)
        args=parser.parse_args(['freeze','--scope-profile','default','--user-id','root','--managed-cubes','main'])
        self.assertEqual(args.profile,'default')

    def test_explicit_id_delete_does_not_mix_api_selection_modes(self):
        self.provider.sync_turn('neutral disposable fact', 'neutral reply')
        self.send()
        memory_id=next(iter(self.backend.rows))
        self.provider.client.delete([memory_id])
        body=next(body for path,body in reversed(self.backend.calls) if path=='/product/delete_memory')
        self.assertNotIn('user_id',body,'MemOS treats user_id as a second deletion mode alongside memory_ids')
        self.assertEqual(body['memory_ids'],[memory_id])
        self.assertEqual(body['writable_cube_ids'],['main'])

def load_tests(loader, tests, pattern):
    return unittest.TestSuite([DeploymentRegressionTests('test_explicit_id_delete_does_not_mix_api_selection_modes'), DeploymentRegressionTests('test_admin_cli_supports_unambiguous_scope_profile_flag')])

if __name__=='__main__':unittest.main()
