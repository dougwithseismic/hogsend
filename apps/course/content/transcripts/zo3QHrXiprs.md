Today we're going to talk about SAS metrics which is one of my favorite topics. So we're going to go over some of the most important most essential metrics we use in SAS to understand how we're doing as a subscription businesses and also to benchmark ourselves against other SAS businesses. So let's get into it.

The first metric we're going to look at probably the most widely used metric in SAS is monthly recurring revenue. MR is a forward-looking metric of basically how much revenue you're going to generate next month and the month after from your existing subscriber base. What this does is provides you sort of a really clear snapshot of how you're doing as a subscription business.

And because it's also such a ubiquitous metric in SAS, it's really helpful to help you sort of benchmark yourself against the other SAS peers out there. Another way to think about MR to kind of really gro it is to think, well, if all my subscribers were paying monthly and none of them canceled, none of them upgraded or downgraded, it's how much you would charge your customers in total next month.

Of course, that's never actually the case. MR and cash flow are different metrics and it's important to understand that they're different and why they're different. Most obvious example is say you had an annual deal and you charged them $1,200 for the year. That is going to bring you in $1,200 in cash flow minus any transaction fees.

But in MR, that's only going to contribute $100 cuz you're going to divide that number by 12. So that's just one way in which MR and cash flow can diverge. Okay. So next we're going to talk about, you know, how you measure MR. If you're dealing with a monthly subscription with no discounts on it, you can just take the monthly value of that subscription.

If there are discounts, you should deduct those unless the discounts are set to expire, you know, next month or something like that, then perhaps it's safe to not deduct those. You shouldn't deduct card transaction fees from your MR. Of course, if you do have multimonth subscriptions, like quarterly subscriptions, annual subscriptions, you should divide the value of those by 12 to give you the monthly amount.

You should exclude one-time payments from your monthly recurring revenue because you only want the recurring part of your revenue. If it's the first time you're going to be charging a new customer, you probably want to wait until the payment goes through before you recognize the MR from that subscription. How do you actually physically measure it?

Well, invoices is the most common way to construct a sort of reliable history of MR. Passing the invoices, all the line items on those invoices. This is what Chartmogul does. We use invoices, but we also ingest a real-time feed of also subscription events. things like scheduled subscription adjustments, scheduled cancellations, pending invoice items, things like that which help us to give a little bit more of a real-time accuracy to the MR versus purely relying on the invoice history.

But the invoice history is the usual way of getting a reliable history of all the changes to a subscriber base. So the next metric we're going to talk about is ARR and ARR actually sort of has two meanings. The first is annualized run rate or sometimes just annual run rate and the other is annual recurring revenue.

These days SAS is a global phenomena and monthly subscriptions are much more normal than annual subscriptions. It's much more frequent and most SAS businesses especially high volume productled growth style SAS businesses will have more monthly subscribers than annual subscribers. Because of that ARR has kind of shifted towards the annualized run rate definition.

So what is annualized run rate and why is it useful? Well annualized run rate is really just your MR times by 12. Why is this useful? Well, once you've been around for a few years, like chart mogul, we've been in business now for over 10 years. After a couple of years in SAS, you just naturally start to think in terms of years and not in terms of month.

And that's why annual run rate is just a more helpful way to think about your business. The one danger though with annualized run rate, and it's worth noting this, is unlike MR, which will tell you how much revenue you're going to make from your existing customers in the next month, annual run rate isn't quite the same thing because you're taking your MR, you're times by 12, and if you have an ARR of $10 million, say, but your annual revenue retention rate is only 80%.

Then you're only going to make $8 million over the next 12 months, all things being equal, from your existing customer base. So it's just useful to be aware of that when you think about annualized run rate plan around that especially if you're planning budgeting and spending. What about annual recurring revenue? Now this is a older metrics use less day-to-day but you know if you are an enterprise SAS business that has all or mostly annual contracts then this is a good metric and that really does mean you know this is how much annual revenue you have that is recurring is fairly reliable more than tsing your MR by 12.

annual recurring revenue if you do have a mix of monthly and quarterly and annual subscribers will be lower than the annualized run rate cuz annual recurring revenue per its definition excludes nonual customers. Okay, so the next metric we're going to talk about is our per average revenue per account. What that means is how much your average customer from your active subscriber base is paying you per month.

It's really simple to calculate. All you do is take your current MR and divide it by your current active number of paid subscribers. It's pretty simple metric. It can be useful to kind of help you understand the impact of pricing change. Is that going to drive the upper up or down? The impact of expansion revenue over time.

Okay. So, next we're going to talk about churn and retention. And now churn is how much of something you're losing per year. And retention is how much of the same thing you're keeping hold of per year. I'm going to talk about the three most important kind of churn and retention metrics. First is customer churn rate.

The inverse of that is customer retention rate. And that is really the rate at which you are losing customers over a given time period. At the start of the month with 100 customers and of those 100 customers only 90 are still paying an active at the end of the month then you have a monthly customer churn rate of 10%.

Cuz you only have 90 of those 100 customers left. Inversely you have a customer retention rate of 90%. It's a really simple metric but again great way to benchmark yourself, great way to understand your business. And what you really want to do is look at the trend of this over time. Is your logo churn rate increasing or decreasing over time?

It's also more meaningful if you segment it. So you might want to look at what is the customer churn rate, your larger customers versus your smaller customers using like filtering and segmentation tools. Okay, so the next metric we're going to look at is gross revenue retention rate. There are two types of revenue retention or revenue churn rate that we look at in SAS normally.

The first is gross revenue retention rate and the second is net revenue retention rate. I feel like net revenue retention steals a lot of the spotlight, especially in VC world, Twitter world, things like that. Often hear about net revenue retention rate and how companies should have over 100% net revenue retention and how that's so good.

And that's true and everything, but I think gross revenue retention rate deserves a little bit more attention. And I personally find it more useful as the operator of a SAS business because it doesn't try to gloss over bad news. What is gross revenue retention rate? It's how much revenue you're losing to churn and contraction.

Contraction means downgrades. Anything that reduces the MR of a customer, you know, giving someone a discount cause contraction. What it doesn't do, unlike net retention, is offset that by any upgrades or account expansion. Say you have a,000 customers and a million dollars of ARR at the start of the year. At the end of the year, you look at how much churn and contraction you've experienced from those thousand subscribers.

So, what percentage of revenue have you lost from that? So it's not the amount of ARR that that thousand customers is paying you a year later because that would be net. We will talk about net revenue retention still useful. It has its place. It's a little bit easier to measure in a way.

You say you take the same thousand customers paying you a million dollars a year in ARR at the start of the year and then you look at those same thousand customers at the end of the year and then you say what percentage of that you know million is still active. If it's $900,000 then your net revenue retention is 90%.

Net revenue churn is 10% on the year. However, that with the net retention, it can actually be above 100%. If it's churn, it's negative revenue churn, something that all SAS companies aim for ideally. And that's when the value of account expansions, the value of upgrades, the value of people adding more seats or moving on to higher plans that exceeds the negative impact of subscribers cancelling or downgrading, etc.

You can have an annual net revenue retention above 100%. It might be 110, 120%, that would be like top tier numbers there. Okay. Okay, so the next metric we're going to talk about is lifetime value or LTV. What is this metric? How do you measure it and why is it useful? So LTV is a estimate of how much economic value you're going to generate from an average customer that you add today.

The definition of that is usually to take the total estimate of the revenue that you'll generate from the customer and deduct the margin. How do you measure lifetime value? It can be pretty complicated. The most common formula, which is I guess a good starting point, say you have a $100 arper. So your average customer pays you $100 a month and you have a 10% monthly churn rate.

Divide $100 by 10% you will end up with a $1,000 lifetime value. Because if a customer will stay with you an average of 10 months and during those 10 months, they'll pay you $100 a month and you'll end up with LTV of $1,000. Why is lifetime value useful? A to benchmark your lifetime value against other companies.

Another is to kind of decide how much you're willing to spend to acquire new customers as well. Now, not all SAS companies really spend heavily to acquire customers. Some really rely on word of mouth and social media and other things that aren't particularly expensive. But if you are a SAS company that spends heavily on outbound uh headcount or you're spending heavily on search engine marketing or other paid marketing, maybe going to field marketing, going to conferences, then LTV is very important to you because you want to make sure that you have a good ratio between your cost of acquisition for these paid customers that you acquire via paid methods and the lifetime value that those customers are going to bring in.

The last metric we'll look at is cost of acquisition. And almost all SAS companies have some customers that come in organically via word of mouth or SEO or something like that. But a lot spend money to acquire customers via paid marketing or outbound sales or things like that that have a cost attached to them.

And therefore, it's good to understand, you know, how much on average you're paying to acquire a new customer. That's what the cost of acquisition cost is. Another thing that I want to talk about is something called MR movements. And this isn't necessarily a metric, but it's a really, really useful way to think about your MR and to understand your business.

The key MR movements are new business MR, expansion MR, contraction MR, churn MR, and reactivation MR. What this does is it breaks down the movements, the changes in MR over time. And when you put that together in a chart, it just allows you a way to really understand the dynamics of your SAS business.

What's causing your MR chart to go up or down in the way that it is? Are you growing faster this month because churn is lower, or are you growing faster because you're getting more new customers? So you're getting more new beers or you're getting more reactivation. These are the kind of core five or six influencing factors that make your MR line or your AR line go up or down.

So when you break it down like this into these MR movements, it just makes things really, really easy. One of my favorite charts in Charm Mogul is the MR movements chart combined with the highle ARR chart, you can really understand, you know, what's going on in your SAS business really, really quickly. Thanks everybody for listening and I hope you enjoyed this primer to SAS metrics.

If you want help generating these metrics and measuring these metrics and you use something like a Stripe for your SAS business, then Choogle, our software can help very, very quickly. Of course, you don't have to use Chart Mogul, but it's one of the options out there. Thanks everybody.
