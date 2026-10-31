// ABOUTME: Задаёт только контрольный тест стоимости одного долговечного шага.
// ABOUTME: Этот workflow не входит в продуктовый runtime и не меняет маршруты Приёма.
import {proxyActivities} from '@temporalio/workflow';
const {writeSink}=proxyActivities({startToCloseTimeout:'10 seconds'});
/** Выполняет ту же SQL-операцию, что контрольный JetStream consumer. */
export async function intakeBenchmark(id){await writeSink(id);}
