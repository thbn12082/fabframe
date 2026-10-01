from collections import defaultdict
from typing import Dict, List, Set, Tuple

from simulation.classes import Machine, Route, Lot
from simulation.dispatching.dm_lot_for_machine import LotForMachineDispatchManager
from simulation.dispatching.dm_machine_for_lot import MachineForLotDispatchManager
from simulation.event_queue import EventQueue
from simulation.events import MachineDoneEvent, LotDoneEvent, BreakdownEvent, MachineRecoveryEvent, ReleaseEvent
from simulation.plugins.interface import IPlugin


class Instance:

    def __init__(self, machines: List[Machine], routes: Dict[str, Route], lots: List[Lot],
                 setups: Dict[Tuple, int], setup_min_run: Dict[str, int], breakdowns: List[BreakdownEvent],
                 lot_for_machine, plugins, initial_time_limit=None):
        self.plugins: List[IPlugin] = plugins
        self.lot_waiting_at_machine = defaultdict(lambda: (0, 0))

        self.free_machines: List[bool] = []
        self.usable_machines: Set[Machine] = set()
        self.usable_lots: List[Lot] = list()

        self.machines: List[Machine] = [m for m in machines]
        self.family_machines = defaultdict(lambda: [])
        for m in self.machines:
            self.family_machines[m.family].append(m)
        self.routes: Dict[str, Route] = routes
        self.setups: Dict[Tuple, int] = setups
        self.setup_min_run: Dict[str, int] = setup_min_run

        self.dm = LotForMachineDispatchManager() if lot_for_machine else MachineForLotDispatchManager()
        self.dm.init(self)

        self.dispatchable_lots: List[Lot] = lots
        self.dispatchable_lots.sort(key=lambda k: k.release_at)
        self.active_lots: List[Lot] = []
        self.done_lots: List[Lot] = []

        self.events = EventQueue()

        self.current_time = 0
        self.fixed_horizon_natural_empty_at = None

        for plugin in self.plugins:
            plugin.on_sim_init(self)

        if initial_time_limit is None:
            # Preserve the legacy initialization order exactly.
            self.next_step()
            self.free_up_machines(self.machines)
            for br in breakdowns:
                self.add_event(br)
        else:
            # A horizon can coincide with a first breakdown/PM. Queue those
            # events before the inclusive bounded advance so same-time events
            # and releases are both consumed at H.
            for br in breakdowns:
                self.add_event(br)
            self.next_step(until=initial_time_limit)
            self.free_up_machines(self.machines)

        self.printed_days = -1

    @property
    def current_time_days(self):
        return self.current_time / 3600 / 24

    @staticmethod
    def _batch_identity(lots):
        return ','.join(sorted(
            str(getattr(lot, 'idx', getattr(lot, 'lot_id', 'unknown-lot')))
            for lot in lots
        ))

    @staticmethod
    def _step_operation(lot, step):
        route_value = getattr(step, 'route_id', None)
        route_id = '' if route_value is None else str(route_value)
        step_key = (route_id, str(getattr(step, 'order', 'unknown-step')))
        active = getattr(lot, 'semantic_active_visit', None)
        if active is not None and active[0] == step_key:
            visit = active[1]
        else:
            visit = getattr(lot, 'semantic_step_visits', {}).get(step_key, 1)
        return 'route:%s:step:%s:visit:%s' % (
            route_id, getattr(step, 'order', 'unknown-step'), visit
        )

    @staticmethod
    def _begin_step_visit(lot, step):
        route_value = getattr(step, 'route_id', None)
        route_id = '' if route_value is None else str(route_value)
        step_key = (route_id, str(getattr(step, 'order', 'unknown-step')))
        visits = getattr(lot, 'semantic_step_visits', None)
        if visits is None:
            visits = {}
            lot.semantic_step_visits = visits
        visit = visits.get(step_key, 0) + 1
        visits[step_key] = visit
        lot.semantic_active_visit = (step_key, visit)
        return visit

    def _step_draw_context(self, lot, step, component, draw_kind, operation):
        return {
            'component': component,
            'draw_kind': draw_kind,
            'subject_id': 'lot:%s' % getattr(lot, 'idx', getattr(lot, 'lot_id', 'unknown-lot')),
            'operation_id': '%s:%s' % (self._step_operation(lot, step), operation),
        }

    @staticmethod
    def _sample_distribution(distribution, context):
        """Keep third-party/test distribution objects with legacy sample() usable."""

        if getattr(distribution, 'supports_semantic_context', False):
            return distribution.sample(context)
        return distribution.sample()

    def next_step(self, until=None):
        """Advance one deterministic queue/release timestamp.

        ``until`` is an opt-in inclusive wall for a fixed-horizon caller.  It
        never mutates the legacy no-limit path: when omitted, the original
        event/release ordering is retained byte-for-byte.  When supplied, all
        work timestamped exactly at the wall is processed, whereas later work
        remains queued and the authoritative clock stops exactly at the wall.
        """

        if until is None:
            process_until = []
            if len(self.events.arr) > 0:
                process_until.append(max(0, self.events.first.timestamp))
            process_until.append(max(0, self.dispatchable_lots[0].release_at))
            process_until = min(process_until)
            while len(self.events.arr) > 0 and self.events.first.timestamp <= process_until:
                ev = self.events.pop_first()
                self.current_time = max(0, ev.timestamp, self.current_time)
                # print(f'Time stamp {self.current_time}')
                ev.handle(self)
            ReleaseEvent.handle(self, process_until)
            return True

        if isinstance(until, bool) or not isinstance(until, (int, float)):
            raise TypeError('fixed horizon must be a finite number')
        if until != until or until in (float('inf'), float('-inf')):
            raise ValueError('fixed horizon must be finite')
        until = float(until)
        if until < self.current_time:
            raise ValueError('fixed horizon cannot precede current simulation time')

        process_until = []
        if len(self.events.arr) > 0:
            process_until.append(max(0, self.events.first.timestamp))
        if len(self.dispatchable_lots) > 0:
            process_until.append(max(0, self.dispatchable_lots[0].release_at))
        if not process_until or min(process_until) > until:
            self.current_time = until
            return False
        process_until = min(process_until)
        while len(self.events.arr) > 0 and self.events.first.timestamp <= process_until:
            ev = self.events.pop_first()
            self.current_time = max(0, ev.timestamp, self.current_time)
            # print(f'Time stamp {self.current_time}')
            ev.handle(self)
        ReleaseEvent.handle(self, process_until)
        return True

    def free_up_machines(self, machines):
        # add machine to list of available machines
        for machine in machines:
            machine.events.clear()
            if machine.is_down:
                machine.down_was_free = True
                continue
            self.dm.free_up_machine(self, machine)

            for plugin in self.plugins:
                plugin.on_machine_free(self, machine)

    def free_up_lots(self, lots: List[Lot]):
        # add lot to lists, make it available
        for lot in lots:
            lot.free_since = self.current_time
            step_found = False
            while len(lot.remaining_steps) > 0:
                old_step = None
                if lot.actual_step is not None:
                    rework_context = self._step_draw_context(
                        lot, lot.actual_step, 'rework-bernoulli',
                        'rework-bernoulli', 'rework'
                    )
                    lot.processed_steps.append(lot.actual_step)
                    old_step = lot.actual_step
                if lot.actual_step is not None and lot.actual_step.has_to_rework(
                    lot.idx,
                    rework_context,
                ):
                    rw_step = lot.actual_step.rework_step
                    removed = lot.processed_steps[rw_step - 1:]
                    lot.processed_steps = lot.processed_steps[:rw_step - 1]
                    lot.remaining_steps = removed + lot.remaining_steps
                lot.actual_step, lot.remaining_steps = lot.remaining_steps[0], lot.remaining_steps[1:]
                self._begin_step_visit(lot, lot.actual_step)
                if lot.actual_step.has_to_perform(
                    self._step_draw_context(
                        lot, lot.actual_step, 'sampling-bernoulli',
                        'sampling-bernoulli', 'sampling'
                    )
                ):
                    # print(f'Lot {lot.idx} step {len(lot.processed_steps)} / {len(lot.remaining_steps)}')
                    self.dm.free_up_lots(self, lot)
                    step_found = True
                    for plugin in self.plugins:
                        plugin.on_step_done(self, lot, old_step)
                    break
            if not step_found:
                assert len(lot.remaining_steps) == 0
                lot.actual_step = None
                lot.done_at = self.current_time
                # print(f'Lot {lot.idx} is done {len(self.active_lots)} {len(self.done_lots)} {self.current_time_days}')
                self.active_lots.remove(lot)
                self.done_lots.append(lot)
                for plugin in self.plugins:
                    plugin.on_lot_done(self, lot)

            for plugin in self.plugins:
                plugin.on_lot_free(self, lot)

    def dispatch(self, machine: Machine, lots: List[Lot], decision_context=None):
        if machine.is_down:
            raise RuntimeError(f'Cannot dispatch to machine {machine.idx} while it is down')
        # Preserve the queue exactly as the dispatcher saw it. Replay and audit
        # plugins need this callback before reserve() removes the selected lots.
        for plugin in self.plugins:
            plugin.on_dispatch_decision(self, machine, lots, decision_context)
        # remove machine and lot from active sets
        self.reserve_machine_lot(lots, machine)
        lwam = self.lot_waiting_at_machine[machine.family]
        self.lot_waiting_at_machine[machine.family] = (lwam[0] + len(lots),
                                                       lwam[1] + sum([self.current_time - l.free_since for l in lots]))
        for lot in lots:
            lot.waiting_time += self.current_time - lot.free_since
            if lot.actual_step.batch_max > 1:
                lot.waiting_time_batching += self.current_time - lot.free_since
            if lot.actual_step.order == lot.cqt_waiting:
                if lot.cqt_deadline < self.current_time:
                    for plugin in self.plugins:
                        plugin.on_cqt_violated(self, machine, lot)
                lot.cqt_waiting = None
                lot.cqt_deadline = None
            if lot.actual_step.cqt_for_step is not None:
                # Close an incoming window before opening the next one: some
                # steps are both a CQT target and the source of a new window.
                lot.cqt_waiting = lot.actual_step.cqt_for_step
                # CQT is a relative time window starting when this step begins,
                # not an absolute timestamp from the start of the simulation.
                lot.cqt_deadline = self.current_time + lot.actual_step.cqt_time
        # compute times for lot and machine
        lot_time, machine_time, setup_time = self.get_times(self.setups, lots, machine)
        # compute per-piece preventive maintenance requirement
        for i in range(len(machine.pieces_until_maintenance)):
            machine.pieces_until_maintenance[i] -= sum([l.pieces for l in lots])
            if machine.pieces_until_maintenance[i] <= 0:
                cycle = machine.maintenance_cycles[i]
                s = self._sample_distribution(machine.maintenance_time[i], {
                    'component': 'maintenance-repair-duration',
                    'draw_kind': 'maintenance-repair-duration',
                    'subject_id': 'machine:%s:maintenance-slot:%s' % (machine.idx, i),
                    'operation_id': 'cycle:%s' % cycle,
                })
                machine.maintenance_cycles[i] = cycle + 1
                machine_time += s
                machine.pieces_until_maintenance[i] = machine.piece_per_maintenance[i]
                machine.pmed_time += s
        # if there is ltl dedication, dedicate lot for selected step
        for lot in lots:
            if lot.actual_step.lot_to_lens_dedication is not None:
                lot.dedications[lot.actual_step.lot_to_lens_dedication] = machine.idx
        # decrease / eliminate min runs required before next setup
        if machine.min_runs_left is not None:
            machine.min_runs_left -= len(lots)
            if machine.min_runs_left <= 0:
                machine.min_runs_left = None
                machine.min_runs_setup = None
        # add events
        machine_done = self.current_time + machine_time + setup_time
        lot_done = self.current_time + lot_time + setup_time
        ev1 = MachineDoneEvent(machine_done, [machine])
        ev2 = LotDoneEvent(lot_done, [machine], lots)
        self.add_event(ev1)
        self.add_event(ev2)
        machine.events += [ev1, ev2]

        for plugin in self.plugins:
            plugin.on_dispatch(self, machine, lots, machine_done, lot_done)
        return machine_done, lot_done

    def get_times(self, setups, lots, machine):
        first = lots[0]
        batch_id = self._batch_identity(lots)
        lot_attempts = '|'.join(sorted(
            'lot:%s:%s' % (
                getattr(lot, 'idx', getattr(lot, 'lot_id', 'unknown-lot')),
                self._step_operation(lot, lot.actual_step),
            )
            for lot in lots
        ))
        operation = 'batch:%s:attempts:%s' % (batch_id, lot_attempts)
        subject = 'machine:%s:batch:%s' % (
            getattr(machine, 'idx', getattr(machine, 'machine_id', 'unknown-machine')),
            batch_id,
        )
        proc_t_samp = self._sample_distribution(first.actual_step.processing_time, {
            'component': 'processing-duration',
            'draw_kind': 'processing-duration',
            'subject_id': subject,
            'operation_id': operation,
        })
        lot_time = proc_t_samp + machine.load_time + machine.unload_time
        for lot in lots:
            lot.processing_time += lot_time
        if len(first.remaining_steps) > 0:
            next_step = first.remaining_steps[0]
            tt = self._sample_distribution(next_step.transport_time, {
                'component': 'transport-duration',
                'draw_kind': 'transport-duration',
                'subject_id': subject,
                'operation_id': '%s:next-family:%s' % (operation, next_step.family),
            })
            lot_time += tt
            for lot in lots:
                lot.transport_time += tt
        if first.actual_step.processing_time == first.actual_step.cascading_time:
            cascade_t_samp = proc_t_samp
        else:
            cascade_t_samp = self._sample_distribution(first.actual_step.cascading_time, {
                'component': 'cascade-duration',
                'draw_kind': 'cascade-duration',
                'subject_id': subject,
                'operation_id': operation,
            })
        machine_time = cascade_t_samp + (machine.load_time + machine.unload_time if not machine.cascading else 0)
        new_setup = lots[0].actual_step.setup_needed
        if new_setup != '' and machine.current_setup != new_setup:
            if lots[0].actual_step.setup_time is not None:
                setup_time = lots[0].actual_step.setup_time
            elif (machine.current_setup, new_setup) in setups:
                setup_time = setups[(machine.current_setup, new_setup)]
            elif ('', new_setup) in setups:
                setup_time = setups[('', new_setup)]
            else:
                setup_time = 0
        else:
            setup_time = 0
        if new_setup != machine.current_setup and new_setup in self.setup_min_run:
            # Start the counter only on an actual setup change. The dispatched
            # lots are part of the minimum run and must be counted immediately.
            min_runs_left = self.setup_min_run[new_setup] - len(lots)
            machine.min_runs_left = min_runs_left if min_runs_left > 0 else None
            machine.min_runs_setup = new_setup if min_runs_left > 0 else None
            machine.has_min_runs = True
        if setup_time > 0:
            machine.last_setup_time = setup_time
        machine.utilized_time += machine_time
        machine.setuped_time += setup_time
        machine.last_setup = machine.current_setup
        machine.current_setup = new_setup
        return lot_time, machine_time, setup_time

    def reserve_machine_lot(self, lots, machine):
        self.dm.reserve(self, lots, machine)

    def add_event(self, to_insert):
        # insert event to the correct place in the array
        self.events.ordered_insert(to_insert)

    def next_decision_point(self, until=None):
        if until is None:
            return self.dm.next_decision_point(self)
        if isinstance(until, bool) or not isinstance(until, (int, float)):
            raise TypeError('fixed horizon must be a finite number')
        until = float(until)
        while True:
            if self.done:
                if getattr(self, 'fixed_horizon_natural_empty_at', None) is None:
                    self.fixed_horizon_natural_empty_at = self.current_time
                # A natural empty system cannot expose another dispatch, but it
                # does not excuse a fixed-horizon run from draining all queued
                # events/releases due by H.  This keeps the terminal clock and
                # empty-tape proof at H without redefining ``done``.
                if self.current_time >= until:
                    return True
                self.next_step(until=until)
                if self.current_time >= until:
                    return True
                continue
            if len(self.usable_machines) > 0 or len(self.usable_lots) > 0:
                return False
            self.next_step(until=until)
            if self.current_time >= until:
                return False

    def handle_breakdown(self, machine, delay):
        prior_down_until = machine.down_until
        requested_down_until = self.current_time + delay
        if machine.is_down and prior_down_until is not None:
            extension = max(0, requested_down_until - prior_down_until)
            machine.down_until = max(prior_down_until, requested_down_until)
        else:
            extension = delay
            machine.down_until = requested_down_until
        machine.is_down = True

        # An idle machine has no processing events to postpone. It must still
        # be removed from the dispatchable set until the repair finishes.
        if self.free_machines[machine.idx]:
            self.free_machines[machine.idx] = False
            self.usable_machines.discard(machine)
            machine.down_was_free = True

        ta = []
        for ev in machine.events:
            if ev in self.events.arr:
                ta.append(ev)
                self.events.remove(ev)
        for ev in ta:
            ev.timestamp += extension
            self.add_event(ev)
        self.add_event(MachineRecoveryEvent(machine.down_until, machine))

    @property
    def done(self):
        return len(self.dispatchable_lots) == 0 and len(self.active_lots) == 0

    def finalize(self):
        for plugin in self.plugins:
            plugin.on_sim_done(self)

    def print_progress_in_days(self):
        import sys
        if int(self.current_time_days) > self.printed_days:
            self.printed_days = int(self.current_time_days)
            if self.printed_days > 0:
                sys.stderr.write(
                    f'\rDay {self.printed_days}===Throughput: {round(len(self.done_lots) / self.printed_days)}/day=')
                sys.stderr.flush()
