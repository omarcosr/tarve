//! GPU time per frame from D3D11 timestamp queries, for `app.stats()` (`gpu`).
//! Results are read a few frames late without stalling: a slot is reused only
//! once its queries have answered.

use windows::Win32::Graphics::Direct3D11::{
    D3D11_ASYNC_GETDATA_DONOTFLUSH, D3D11_QUERY, D3D11_QUERY_DATA_TIMESTAMP_DISJOINT,
    D3D11_QUERY_DESC, D3D11_QUERY_TIMESTAMP, D3D11_QUERY_TIMESTAMP_DISJOINT, ID3D11Device,
    ID3D11DeviceContext, ID3D11Query,
};

const SLOTS: usize = 4;

struct Slot {
    disjoint: ID3D11Query,
    start: ID3D11Query,
    end: ID3D11Query,
    pending: bool,
}

pub(crate) struct GpuTimer {
    slots: Vec<Slot>,
    next: usize,
    /// Slot of the frame being timed, between `begin` and `end`.
    open: Option<usize>,
    done: Vec<f64>,
}

fn query(device: &ID3D11Device, kind: D3D11_QUERY) -> Option<ID3D11Query> {
    let desc = D3D11_QUERY_DESC {
        Query: kind,
        MiscFlags: 0,
    };
    let mut query = None;
    unsafe { device.CreateQuery(&desc, Some(&mut query)) }.ok()?;
    query
}

impl GpuTimer {
    pub(crate) fn new(device: &ID3D11Device) -> Option<Self> {
        let slots = (0..SLOTS)
            .map(|_| {
                Some(Slot {
                    disjoint: query(device, D3D11_QUERY_TIMESTAMP_DISJOINT)?,
                    start: query(device, D3D11_QUERY_TIMESTAMP)?,
                    end: query(device, D3D11_QUERY_TIMESTAMP)?,
                    pending: false,
                })
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            slots,
            next: 0,
            open: None,
            done: Vec::new(),
        })
    }

    pub(crate) fn begin(&mut self, context: &ID3D11DeviceContext) {
        self.collect(context);
        let slot = &self.slots[self.next];
        if slot.pending {
            return;
        }
        unsafe {
            context.Begin(&slot.disjoint);
            context.End(&slot.start);
        }
        self.open = Some(self.next);
    }

    pub(crate) fn end(&mut self, context: &ID3D11DeviceContext) {
        let Some(index) = self.open.take() else {
            return;
        };
        let slot = &mut self.slots[index];
        unsafe {
            context.End(&slot.end);
            context.End(&slot.disjoint);
        }
        slot.pending = true;
        self.next = (index + 1) % SLOTS;
    }

    fn collect(&mut self, context: &ID3D11DeviceContext) {
        let flags = D3D11_ASYNC_GETDATA_DONOTFLUSH.0 as u32;
        for offset in 0..SLOTS {
            let slot = &mut self.slots[(self.next + offset) % SLOTS];
            if !slot.pending {
                continue;
            }
            // GetData reports "not yet" (S_FALSE) as success too: a query that has
            // answered is one that overwrote its sentinel.
            let mut disjoint = D3D11_QUERY_DATA_TIMESTAMP_DISJOINT::default();
            let (mut start, mut end) = (u64::MAX, u64::MAX);
            unsafe {
                let _ = context.GetData(
                    &slot.disjoint,
                    Some((&mut disjoint as *mut D3D11_QUERY_DATA_TIMESTAMP_DISJOINT).cast()),
                    size_of::<D3D11_QUERY_DATA_TIMESTAMP_DISJOINT>() as u32,
                    flags,
                );
                if disjoint.Frequency == 0 {
                    break;
                }
                let _ = context.GetData(&slot.start, Some((&mut start as *mut u64).cast()), 8, flags);
                let _ = context.GetData(&slot.end, Some((&mut end as *mut u64).cast()), 8, flags);
            }
            if start == u64::MAX || end == u64::MAX {
                break;
            }
            slot.pending = false;
            if !disjoint.Disjoint.as_bool() && disjoint.Frequency > 0 && end >= start {
                self.done
                    .push((end - start) as f64 * 1000.0 / disjoint.Frequency as f64);
            }
        }
    }

    pub(crate) fn take(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.done)
    }
}
