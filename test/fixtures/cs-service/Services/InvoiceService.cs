using Fixture.Domain;
using Fixture.Helpers;
using Newtonsoft.Json;

namespace Fixture.Services;

public class InvoiceService : Repository<Invoice>
{
    public InvoiceService() : base("invoices") { }
    public override Task<Invoice?> FindAsync(Guid id) => Task.FromResult<Invoice?>(null);
    public string Render(Invoice i) => JsonConvert.SerializeObject(MoneyFormatter.Format(i.Total));
}
