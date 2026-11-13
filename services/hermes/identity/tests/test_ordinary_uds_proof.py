# ABOUTME: Проверяет, что Root UDS proof не принимает skip или неверное число тестов.
# ABOUTME: Не выполняет root тест и не обращается к действующим службам.
import unittest
from ordinary_uds_proof import require_one


class ProofOutputTest(unittest.TestCase):
    def test_only_one_unskipped_success_is_accepted(self):
        require_one(0,'synthetic ... ok\n\nRan 1 test in 0.001s\n\nOK\n')
        for rc,output in ((0,'Ran 1 test in 0.001s\n\nOK (skipped=1)\n'),
                          (0,'Ran 0 tests in 0.001s\n\nOK\n'),
                          (0,'Ran 2 tests in 0.001s\n\nOK\n'),
                          (1,'Ran 1 test in 0.001s\n\nOK\n'),(0,'')):
            with self.subTest(rc=rc,output=output), self.assertRaises(RuntimeError):
                require_one(rc,output)
